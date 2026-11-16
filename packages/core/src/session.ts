import {
  answerFromState,
  type Command,
  classifyIntent,
  matchWakeWord,
  parseChatCommand,
} from "./commands";
import { t } from "./i18n";
import type { LlmEngine } from "./llm";
import { MeetingPipeline, type PipelineEvent, type PipelineOptions } from "./pipeline";
import type {
  CaptureEvent,
  CaptureSource,
  MeetingRef,
  Participant,
  TranscriptSegment,
} from "./types";

export type SessionOptions = PipelineOptions & {
  wakeWords: string[];
  joinMessage: string;
  externalGuests: "allow" | "ask" | "leave";
  internalDomains: string[];
  /** The name the assistant shows in the call, to ignore its own chat messages. */
  displayName?: string;
};

export type SessionStatus = "listening" | "paused" | "left";

export type SessionEvent =
  | PipelineEvent
  | { type: "command"; command: Command }
  | { type: "reply"; text: string; command?: Command }
  | { type: "status"; status: SessionStatus; reason?: string };

/** Handles every request the built-in commands do not cover. Wired in by the agent layer. */
export interface AgentRunner {
  run(command: Command, session: MeetingSession): Promise<string>;
}

/** How long after "Open Meetings." the same speaker's next sentence still counts as the request. */
const WAKE_FOLLOW_UP_MS = 10_000;

/**
 * One meeting, live: connects a capture source to the pipeline, applies the consent policy,
 * and answers commands given by voice, in the call's chat or from the panel.
 */
export class MeetingSession {
  readonly pipeline: MeetingPipeline;
  status: SessionStatus = "listening";

  private readonly listeners = new Set<(event: SessionEvent) => void>();
  private commands: Promise<void> = Promise.resolve();
  private announced = false;
  private justAnnounced = false;
  private pausedForConsent = false;
  private armed?: { speaker: string; untilMs: number };
  private readonly people = new Map<string, Participant>();

  constructor(
    readonly source: CaptureSource,
    readonly meeting: MeetingRef,
    private readonly llm: { fast: LlmEngine; smart: LlmEngine },
    readonly options: SessionOptions,
    private readonly agent?: AgentRunner,
  ) {
    this.pipeline = new MeetingPipeline(meeting, llm, options);
    this.pipeline.on((event) => this.emit(event));
  }

  on(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Runs until the source ends or the assistant is asked to leave. */
  async run(): Promise<void> {
    try {
      for await (const event of this.source.start(this.meeting)) {
        // The first event means we are in the call: say who we are before anything else.
        this.justAnnounced = !this.announced;
        if (!this.announced) await this.announce();
        this.onEvent(event);
        this.justAnnounced = false;
        if (this.status === "left") break;
      }
    } finally {
      await this.commands;
      this.pipeline.flush();
      await this.pipeline.idle();
      await this.source.stop();
      this.setStatus("left", "ended");
    }
  }

  /** A command typed in the web panel. */
  submit(text: string, from = "panel"): Promise<void> {
    return this.enqueue({ request: text, from, via: "panel", atMs: this.nowMs() });
  }

  /** Leaves the meeting. Safe to call more than once. */
  leave(reason = "requested"): void {
    if (this.status === "left") return;
    this.setStatus("left", reason);
  }

  private nowMs(): number {
    return this.pipeline.segments.at(-1)?.endMs ?? 0;
  }

  private setStatus(status: SessionStatus, reason?: string): void {
    if (this.status === status && status !== "left") return;
    const changed = this.status !== status;
    this.status = status;
    if (changed) this.emit({ type: "status", status, ...(reason ? { reason } : {}) });
  }

  private async say(text: string, command?: Command): Promise<void> {
    this.emit({ type: "reply", text, ...(command ? { command } : {}) });
    try {
      await this.source.sendChat?.(text);
    } catch (error) {
      this.emit({
        type: "warning",
        message: `could not write to the call chat: ${(error as Error).message}`,
      });
    }
  }

  private async announce(): Promise<void> {
    this.announced = true;
    await this.say(this.options.joinMessage);
  }

  private onEvent(event: CaptureEvent): void {
    if (event.type === "participant") {
      this.onParticipant(event.action, event.participant);
      this.pipeline.handle(event);
    } else if (event.type === "transcript") {
      // While paused nothing is stored, shown or sent to a model.
      if (this.status !== "listening") return;
      this.pipeline.handle(event);
      if (!event.segment.partial) this.onSpeech(event.segment);
    } else if (event.type === "chat") {
      if (event.message.sender === this.options.displayName) return;
      this.pipeline.handle(event);
      const parsed = parseChatCommand(event.message.text, this.options.wakeWords);
      if (!parsed) return;
      const input = {
        request: parsed.request,
        from: event.message.sender,
        via: "chat" as const,
        atMs: event.message.atMs,
      };
      if (parsed.exact) this.control({ ...input, intent: parsed.exact });
      else void this.enqueue(input);
    } else {
      this.pipeline.handle(event);
    }
  }

  private isExternal(participant: Participant): boolean {
    if (participant.external !== undefined) return participant.external;
    const domains = this.options.internalDomains.map((domain) => domain.toLowerCase());
    if (domains.length === 0) return false;
    // With a list of internal domains, anyone we cannot place inside it counts as external.
    const domain = participant.email?.split("@")[1]?.toLowerCase();
    return !domain || !domains.includes(domain);
  }

  private onParticipant(action: "joined" | "left", participant: Participant): void {
    if (action === "left") {
      this.people.delete(participant.id);
      return;
    }
    const external = this.isExternal(participant);
    this.people.set(participant.id, { ...participant, external });
    if (participant.name === this.options.displayName) return;

    const policy = this.options.externalGuests;
    const language = this.options.language;
    if (external && policy === "leave") {
      // Immediate, like pause: nothing the guest says is recorded.
      this.leave("external guest joined");
      this.commands = this.commands.then(() => this.say(t(language, "externalLeave")));
    } else if (external && policy === "ask") {
      this.pausedForConsent = true;
      this.setStatus("paused", "external guest joined");
      this.commands = this.commands.then(() => this.say(t(language, "externalAsk")));
    } else if (!this.justAnnounced && this.status === "listening") {
      // Everyone who arrives later is told the meeting is being transcribed.
      this.commands = this.commands.then(() => this.say(this.options.joinMessage));
    }
  }

  private onSpeech(segment: TranscriptSegment): void {
    const wake = matchWakeWord(segment.text, this.options.wakeWords);
    let request: string | undefined;
    if (wake) {
      if (wake.rest.length >= 3) request = wake.rest;
      else this.armed = { speaker: segment.speaker, untilMs: segment.endMs + WAKE_FOLLOW_UP_MS };
    } else if (this.armed?.speaker === segment.speaker && segment.startMs <= this.armed.untilMs) {
      request = segment.text;
    }
    if (!request) return;
    this.armed = undefined;
    void this.enqueue({
      request,
      from: segment.speaker,
      via: "voice",
      atMs: segment.endMs,
      sourceSegmentId: segment.id,
    });
  }

  private enqueue(input: Omit<Command, "intent">): Promise<void> {
    this.commands = this.commands
      .then(() => this.execute(input))
      .catch((error: unknown) => {
        this.emit({ type: "warning", message: `command failed: ${(error as Error).message}` });
      });
    return this.commands;
  }

  private canResume(sender: string): boolean {
    if (!this.pausedForConsent) return true;
    const person = [...this.people.values()].find((p) => p.name === sender);
    return person ? !person.external : sender === "panel";
  }

  /**
   * Pause, resume and leave take effect immediately, before anything else that is queued:
   * once someone says stop, not one more line is recorded. Only the confirmation is queued.
   */
  private control(command: Command): void {
    if (this.status === "left") return;
    const language = this.options.language;
    this.emit({ type: "command", command });
    let message: string;
    if (command.intent === "leave") {
      this.leave(`asked by ${command.from}`);
      message = t(language, "leaving");
    } else if (command.intent === "pause") {
      this.setStatus("paused", `asked by ${command.from}`);
      message = t(language, "paused");
    } else if (!this.canResume(command.from)) {
      message = t(language, "notAllowed");
    } else {
      this.pausedForConsent = false;
      this.setStatus("listening", `asked by ${command.from}`);
      message = t(language, "resumed");
    }
    this.commands = this.commands.then(() => this.say(message, command));
  }

  private async execute(input: Omit<Command, "intent">): Promise<void> {
    if (this.status === "left") return;
    const { agentName, language, promptOverrides } = this.options;
    const classified = await classifyIntent(this.llm.fast, input.from, input.request, {
      agentName,
      language,
      ...(promptOverrides ? { promptOverrides } : {}),
      onUsage: (usage) =>
        this.emit({
          type: "usage",
          tier: "fast",
          model: this.llm.fast.model,
          purpose: "intent",
          usage,
        }),
    });
    const command: Command = { ...input, ...classified };
    if (command.intent === "none") return;
    if (command.intent === "leave" || command.intent === "pause" || command.intent === "resume") {
      this.control(command);
      return;
    }
    this.emit({ type: "command", command });

    switch (command.intent) {
      case "summary":
      case "decisions":
      case "action_items":
        // Fold in what was said up to this moment before answering.
        this.pipeline.flush();
        await this.pipeline.idle();
        await this.say(answerFromState(command.intent, this.pipeline.state, language), command);
        return;
      case "agent": {
        if (!this.agent) {
          await this.say(t(language, "agentUnavailable"), command);
          return;
        }
        try {
          await this.say(await this.agent.run(command, this), command);
        } catch (error) {
          this.emit({ type: "warning", message: `agent failed: ${(error as Error).message}` });
          await this.say(t(language, "failed"), command);
        }
      }
    }
  }
}
