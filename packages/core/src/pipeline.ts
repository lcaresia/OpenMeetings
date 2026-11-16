import { type ChatMessage, collectChat, extractJson, type LlmEngine, type Usage } from "./llm";
import { loadPrompt, renderPrompt } from "./prompts";
import {
  applyModelPatch,
  emptyState,
  llmPatchSchema,
  type MeetingState,
  type StatePatch,
  updateState,
} from "./state";
import type {
  CallChatMessage,
  CaptureEvent,
  MeetingRef,
  Participant,
  TranscriptSegment,
} from "./types";

export type PipelineEvent =
  | { type: "transcript"; segment: TranscriptSegment }
  | { type: "participant"; action: "joined" | "left"; participant: Participant; atMs: number }
  | { type: "chat"; message: CallChatMessage }
  | { type: "state"; patch: StatePatch; state: MeetingState }
  | { type: "usage"; tier: "fast" | "smart"; model: string; purpose: string; usage: Usage }
  | { type: "warning"; message: string }
  | { type: "ended"; reason: string };

export type PipelineOptions = {
  agentName: string;
  language: string;
  summaryIntervalSec: number;
  /** A long stretch of speech triggers an update before the interval elapses. */
  maxWindowChars?: number;
  /** ISO date used to resolve "tomorrow" and weekdays. Defaults to the current date. */
  today?: string;
  promptOverrides?: Record<string, string>;
};

/** Consecutive lines by one speaker are joined while the pause between them stays short. */
const MERGE_GAP_MS = 2000;
const MERGE_MAX_CHARS = 500;

/**
 * Turns capture events into a transcript and a structured meeting state.
 *
 * The fast model never sees the whole meeting: each update sends the current state plus only
 * the lines spoken since the previous update, and gets back a JSON Patch.
 */
export class MeetingPipeline {
  state: MeetingState;
  readonly segments: TranscriptSegment[] = [];

  private pending: TranscriptSegment[] = [];
  private lastUpdateMs = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(event: PipelineEvent) => void>();
  private readonly segmentIds = new Set<string>();

  constructor(
    readonly meeting: MeetingRef,
    private readonly llm: { fast: LlmEngine; smart: LlmEngine },
    private readonly options: PipelineOptions,
  ) {
    this.state = emptyState(meeting.title);
  }

  on(listener: (event: PipelineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected emit(event: PipelineEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Feeds one capture event. Never blocks on the model: updates are queued. */
  handle(event: CaptureEvent): void {
    switch (event.type) {
      case "transcript":
        this.onSegment(event.segment);
        break;
      case "participant":
        this.onParticipant(event.action, event.participant);
        this.emit(event);
        break;
      case "chat":
        this.emit(event);
        break;
      case "ended":
        this.flush();
        this.emit(event);
        break;
      case "audio":
        break; // audio is transcribed upstream, by the capture layer
    }
  }

  /** Consumes a capture source to the end and waits for every queued update. */
  async run(source: AsyncIterable<CaptureEvent>): Promise<void> {
    for await (const event of source) this.handle(event);
    this.flush();
    await this.idle();
  }

  /** Sends whatever is pending to the fast model now. */
  flush(): void {
    if (this.pending.length === 0) return;
    const window = this.pending;
    this.pending = [];
    this.lastUpdateMs = window.at(-1)?.endMs ?? this.lastUpdateMs;
    this.chain = this.chain.then(() => this.updateState(window));
  }

  /** Resolves when no update is in flight. */
  idle(): Promise<void> {
    return this.chain;
  }

  private onParticipant(action: "joined" | "left", participant: Participant): void {
    if (action !== "joined" || this.state.participants.some((p) => p.id === participant.id)) return;
    this.commit(updateState(this.state, (draft) => void draft.participants.push(participant)));
  }

  private onSegment(segment: TranscriptSegment): void {
    if (segment.partial) {
      this.emit({ type: "transcript", segment });
      return;
    }
    const last = this.pending.at(-1);
    const joinable =
      last &&
      last.speaker === segment.speaker &&
      segment.startMs - last.endMs <= MERGE_GAP_MS &&
      last.text.length < MERGE_MAX_CHARS;
    let stored: TranscriptSegment;
    if (joinable) {
      last.text = `${last.text} ${segment.text}`;
      last.endMs = segment.endMs;
      stored = last;
    } else {
      stored = { ...segment, partial: false };
      this.segments.push(stored);
      this.segmentIds.add(stored.id);
      this.pending.push(stored);
    }
    this.emit({ type: "transcript", segment: { ...stored } });

    const chars = this.pending.reduce((sum, item) => sum + item.text.length, 0);
    const due = stored.endMs - this.lastUpdateMs >= this.options.summaryIntervalSec * 1000;
    if (due || chars >= (this.options.maxWindowChars ?? 1500)) this.flush();
  }

  private commit(change: { state: MeetingState; patch: StatePatch }): void {
    if (change.patch.length === 0) return;
    this.state = change.state;
    this.emit({ type: "state", patch: change.patch, state: change.state });
  }

  private async updateState(window: TranscriptSegment[]): Promise<void> {
    const system = renderPrompt(loadPrompt("state-update", this.options.promptOverrides), {
      agentName: this.options.agentName,
      language: this.options.language,
      today: this.options.today ?? new Date().toISOString().slice(0, 10),
    });
    const transcript = window.map((s) => `[${s.id}] ${s.speaker}: ${s.text}`).join("\n");
    const { participants: _participants, artifacts: _artifacts, ...notes } = this.state;
    const messages: ChatMessage[] = [
      { role: "system", content: system, cache: true },
      {
        role: "user",
        content: `STATE:\n${JSON.stringify(notes)}\n\nNEW TRANSCRIPT:\n${transcript}`,
      },
    ];

    let ops: unknown;
    try {
      for (let attempt = 0; attempt < 2 && ops === undefined; attempt++) {
        const result = await collectChat(
          this.llm.fast.chat({ messages, json: true, maxTokens: 2000, purpose: "state-update" }),
        );
        if (result.usage) {
          this.emit({
            type: "usage",
            tier: "fast",
            model: this.llm.fast.model,
            purpose: "state-update",
            usage: result.usage,
          });
        }
        try {
          ops = llmPatchSchema.parse(extractJson(result.text)).patch;
        } catch (error) {
          messages.push(
            { role: "assistant", content: result.text },
            {
              role: "user",
              content: `That answer could not be used (${(error as Error).message.slice(0, 200)}). Answer again with only the JSON object {"patch": [...]}.`,
            },
          );
        }
      }
    } catch (error) {
      // The model is unreachable: keep the lines for the next update instead of losing them.
      this.pending = [...window, ...this.pending];
      this.emit({ type: "warning", message: `state update failed: ${(error as Error).message}` });
      return;
    }
    if (ops === undefined) {
      this.emit({
        type: "warning",
        message: "state update skipped: the model did not return a valid patch",
      });
      return;
    }

    const outcome = applyModelPatch(this.state, ops, {
      nowMs: window.at(-1)?.endMs ?? 0,
      knownSegmentIds: this.segmentIds,
    });
    for (const reason of outcome.rejected) {
      this.emit({ type: "warning", message: `patch operation rejected: ${reason}` });
    }
    this.commit(outcome);
  }
}
