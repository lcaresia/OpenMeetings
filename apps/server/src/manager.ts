import { randomUUID } from "node:crypto";
import { type Config, isLocalOnly } from "@open-meetings/config";
import {
  type AgentRunner,
  type Artifact,
  artifactUrl,
  type CaptureSource,
  type Engines,
  emptyState,
  type Logger,
  MeetingSession,
  type SessionEvent,
  type SessionOptions,
} from "@open-meetings/core";
import { engineFetch, type FetchLike, priceFor, usageCost } from "@open-meetings/engines";
import { builtinTools, createAgent, type MeetingSearch, type Tool } from "@open-meetings/tools";
import { type ExportedFile, exportAs } from "./export/formats";
import {
  minutesForChat,
  previousMeetingMemory,
  renderMinutes,
  searchChunks,
  sendWebhook,
  seriesKeyFor,
  writeSummary,
} from "./post-meeting";
import type { MeetingRecord, MeetingStore } from "./storage/store";
import { withStt } from "./stt-source";

/** Events of a live meeting, as seen by panels and protocol adapters. */
export type ManagerEvent =
  | SessionEvent
  | { type: "cost"; totalUsd: number }
  | { type: "latency"; commandId: string; ms: number }
  | { type: "minutes"; markdown: string }
  /** Everything is saved and the meeting is over. Unlike `ended`, which only means the capture stopped. */
  | { type: "closed"; reason: string };

export type LiveMeeting = {
  record: MeetingRecord;
  session: MeetingSession;
  /** Resolves once the meeting is over and everything is saved. */
  done: Promise<void>;
};

export type StartMeeting = {
  url?: string;
  title?: string;
  platform?: string;
  /** A ready capture source (file upload, extension, fixture). Defaults to the bot. */
  source?: CaptureSource;
};

export type ManagerDeps = {
  config: Config;
  engines: Engines;
  store: MeetingStore;
  logger: Logger;
  /** Builds the capture source for a platform link (the bot). */
  botSource?: (meeting: {
    id: string;
    platform: string;
    url?: string;
    title?: string;
  }) => CaptureSource;
  /** Extra tools: MCP servers, ACP agents. */
  tools?: Tool[];
  fetch?: FetchLike;
};

/** Infers the platform from a meeting link. */
export function platformOf(url: string): string {
  const host = new URL(url).hostname;
  if (host === "meet.google.com") return "meet";
  if (host.endsWith("zoom.us")) return "zoom";
  if (host.endsWith("teams.microsoft.com") || host.endsWith("teams.live.com")) return "teams";
  if (host.includes("jitsi") || host === "meet.jit.si") return "jitsi";
  return "unknown";
}

export function sessionOptions(config: Config): SessionOptions {
  return {
    agentName: config.agent.name,
    displayName: config.bot.displayName,
    language: config.agent.language,
    summaryIntervalSec: config.agent.summaryIntervalSec,
    wakeWords: config.agent.wakeWords,
    joinMessage: config.consent.joinMessage,
    externalGuests: config.consent.externalGuests,
    internalDomains: config.consent.internalDomains,
    promptOverrides: config.prompts,
  };
}

/**
 * Owns every meeting: starts the capture, runs the session, saves what happens, and closes the
 * meeting with minutes, search index and webhook. Every consumer (panel, AG-UI, OpenAI-style
 * endpoint, ACP) goes through here.
 */
export class MeetingManager {
  private readonly live = new Map<string, LiveMeeting>();
  private readonly listeners = new Map<string, Set<(event: ManagerEvent) => void>>();
  private readonly fetchFn: FetchLike;
  private readonly tools: Tool[];
  /** Tools a client declared for one command (AG-UI frontend tools), by command id. */
  private readonly commandTools = new Map<string, Tool[]>();

  constructor(private readonly deps: ManagerDeps) {
    this.fetchFn = engineFetch(deps.config, deps.fetch);
    const webFetch = (deps.config.tools.webFetch ?? true) && !isLocalOnly(deps.config);
    this.tools = [...builtinTools({ webFetch }), ...(deps.tools ?? [])];
  }

  /** Audio sources (uploads, the extension's tab audio) need a speech-to-text engine. */
  get canTranscribe(): boolean {
    return Boolean(this.deps.engines.stt);
  }

  get liveMeetings(): LiveMeeting[] {
    return [...this.live.values()];
  }

  getLive(id: string): LiveMeeting | undefined {
    return this.live.get(id);
  }

  /** The current record: live state when the meeting is running, saved state otherwise. */
  get(id: string): MeetingRecord | undefined {
    const live = this.live.get(id);
    if (live) return { ...live.record, state: live.session.pipeline.state };
    return this.deps.store.getMeeting(id);
  }

  list(options: { limit?: number; text?: string } = {}): MeetingRecord[] {
    return this.deps.store.listMeetings(options).map((record) => this.get(record.id) ?? record);
  }

  artifacts(meetingId: string) {
    return this.deps.store.artifacts.list(meetingId);
  }

  artifact(id: string) {
    return this.deps.store.artifacts.get(id);
  }

  /** Saves an edit made on the panel and tells every client about it. */
  async updateArtifact(
    id: string,
    content: Artifact["content"],
    title?: string,
  ): Promise<Artifact | undefined> {
    const existing = await this.deps.store.artifacts.get(id);
    if (!existing || existing.content.type !== content.type) return undefined;
    const updated: Artifact = {
      ...existing,
      ...(title ? { title } : {}),
      content,
      updatedAt: new Date().toISOString(),
    };
    await this.deps.store.artifacts.save(updated);
    const entry = {
      id,
      type: content.type,
      url: artifactUrl(id),
      title: updated.title,
      updatedAt: updated.updatedAt,
    };
    const live = this.live.get(existing.meetingId);
    if (live) live.session.addArtifact(entry);
    else {
      const record = this.deps.store.getMeeting(existing.meetingId);
      if (record) {
        const artifacts = record.state.artifacts.map((item) => (item.id === id ? entry : item));
        this.deps.store.updateMeeting(record.id, { state: { ...record.state, artifacts } });
      }
    }
    return updated;
  }

  exportArtifact(artifact: Artifact, format?: string): ExportedFile {
    return exportAs(artifact, format);
  }

  segments(id: string) {
    const live = this.live.get(id);
    return live ? live.session.pipeline.segments : this.deps.store.listSegments(id);
  }

  subscribe(id: string, listener: (event: ManagerEvent) => void): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  private emit(id: string, event: ManagerEvent): void {
    for (const listener of this.listeners.get(id) ?? []) {
      try {
        listener(event);
      } catch (error) {
        this.deps.logger.warn({ error: String(error) }, "listener failed");
      }
    }
  }

  /** Semantic search over every saved meeting. Empty without an embeddings engine. */
  readonly search: MeetingSearch = async (query, limit) => {
    const embed = this.deps.engines.embed;
    if (!embed) return [];
    const [vector] = await embed.embed([query]);
    if (!vector) return [];
    return this.deps.store.searchChunks(vector, limit).map((hit) => ({
      meetingId: hit.meetingId,
      ...(hit.meetingTitle ? { meetingTitle: hit.meetingTitle } : {}),
      date: hit.startedAt.slice(0, 10),
      text: hit.text,
      score: hit.score,
    }));
  };

  start(options: StartMeeting): LiveMeeting {
    const { config, store, engines, logger } = this.deps;
    const id = randomUUID();
    const platform = options.platform ?? (options.url ? platformOf(options.url) : "panel");
    const seriesKey = seriesKeyFor(options.url, options.title);
    const record: MeetingRecord = {
      id,
      platform,
      ...(options.url ? { url: options.url } : {}),
      ...(options.title ? { title: options.title } : {}),
      ...(seriesKey ? { seriesKey } : {}),
      status: "joining",
      startedAt: new Date().toISOString(),
      state: emptyState(options.title),
      costUsd: 0,
    };
    store.createMeeting(record);

    const meeting = {
      id,
      platform,
      ...(options.url ? { url: options.url } : {}),
      ...(options.title ? { title: options.title } : {}),
    };
    let source = options.source ?? this.deps.botSource?.(meeting);
    if (!source) throw new Error("no capture source available for this meeting");
    source = withStt(source, engines.stt, {
      language: config.agent.language,
      onError: (error) =>
        logger.warn({ meeting: id, error: error.message }, "transcription failed"),
    });

    const previous = seriesKey ? store.lastInSeries(seriesKey, id) : undefined;
    const agent: AgentRunner = createAgent({
      llm: engines.llm.smart,
      tools: this.tools,
      artifacts: store.artifacts,
      search: this.search,
      fetch: this.fetchFn as typeof fetch,
      maxSteps: config.agent.maxToolSteps,
      promptOverrides: config.prompts,
      toolsFor: (command) => (command.id ? (this.commandTools.get(command.id) ?? []) : []),
    });
    const session = new MeetingSession(
      source,
      meeting,
      engines.llm,
      {
        ...sessionOptions(config),
        ...(previous ? { memory: previousMeetingMemory(previous) } : {}),
      },
      agent,
      { beforeStop: (s) => this.close(id, s) },
    );

    let total = 0;
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    const heardAt = new Map<string, number>();
    const commandAt = new Map<string, number>();
    const saveState = () => {
      saveTimer = undefined;
      store.updateMeeting(id, { state: session.pipeline.state });
    };

    session.on((event) => {
      try {
        if (event.type === "transcript" && !event.segment.partial) {
          store.upsertSegment(id, event.segment);
          heardAt.set(event.segment.id, Date.now());
          if (record.status === "joining") {
            record.status = "live";
            store.updateMeeting(id, { status: "live" });
          }
        } else if (event.type === "participant" && record.status === "joining") {
          record.status = "live";
          store.updateMeeting(id, { status: "live" });
        } else if (event.type === "state") {
          saveTimer ??= setTimeout(saveState, 1000);
        } else if (event.type === "usage") {
          const engine = config.engines.llm[event.tier];
          const costUsd = usageCost(event.usage, priceFor(engine, config.pricing));
          store.recordUsage({
            meetingId: id,
            tier: event.tier,
            model: event.model,
            purpose: event.purpose,
            ...event.usage,
            costUsd,
          });
          total += costUsd;
          this.emit(id, event);
          this.emit(id, { type: "cost", totalUsd: total });
          return;
        } else if (event.type === "command") {
          const key = event.command.id ?? `${event.command.via}:${event.command.atMs}`;
          const spoken = event.command.sourceSegmentId
            ? heardAt.get(event.command.sourceSegmentId)
            : undefined;
          commandAt.set(key, spoken ?? Date.now());
        } else if (event.type === "reply" && event.command) {
          const key = event.command.id ?? `${event.command.via}:${event.command.atMs}`;
          const started = commandAt.get(key);
          if (started !== undefined) {
            commandAt.delete(key);
            this.emit(id, event);
            this.emit(id, { type: "latency", commandId: key, ms: Date.now() - started });
            return;
          }
        } else if (event.type === "warning") {
          logger.warn({ meeting: id, warning: event.message }, "meeting warning");
        }
      } catch (error) {
        logger.error({ meeting: id, error: String(error) }, "could not save a meeting event");
      }
      this.emit(id, event);
    });

    const done = session
      .run()
      .then(() => {
        if (record.status !== "failed") record.status = "ended";
      })
      .catch((error: unknown) => {
        record.status = "failed";
        const reason = error instanceof Error ? error.message : String(error);
        record.endReason = reason;
        logger.error({ meeting: id, reason }, "meeting failed");
        this.emit(id, { type: "warning", message: reason });
      })
      .finally(() => {
        if (saveTimer) clearTimeout(saveTimer);
        store.updateMeeting(id, {
          status: record.status,
          state: session.pipeline.state,
          endedAt: new Date().toISOString(),
          ...(record.endReason ? { endReason: record.endReason } : {}),
        });
        this.live.delete(id);
        this.emit(id, { type: "closed", reason: record.endReason ?? "meeting ended" });
        this.listeners.delete(id);
      });

    const live: LiveMeeting = { record, session, done };
    this.live.set(id, live);
    logger.info({ meeting: id, platform, resumedSeries: Boolean(previous) }, "meeting started");
    return live;
  }

  /** Minutes, chat post, search index and webhook. Runs while the source is still connected. */
  private async close(id: string, session: MeetingSession): Promise<void> {
    const { config, store, engines, logger } = this.deps;
    const record = this.live.get(id)?.record ?? store.getMeeting(id);
    if (!record) return;
    const state = session.pipeline.state;
    const segments = session.pipeline.segments;
    if (segments.length === 0 && state.decisions.length === 0) return; // nothing happened

    const input = {
      ...(record.title ? { title: record.title } : {}),
      startedAt: record.startedAt,
      state,
      segments,
      language: config.agent.language,
    };
    const summary = await writeSummary(engines.llm.smart, input, {
      promptOverrides: config.prompts,
      onUsage: (usage) =>
        session.publish({
          type: "usage",
          tier: "smart",
          model: engines.llm.smart.model,
          purpose: "minutes",
          usage,
        }),
    });
    const minutes = renderMinutes(input, summary);
    store.updateMeeting(id, { minutes, state });
    this.emit(id, { type: "minutes", markdown: minutes });

    if (config.outputs.postSummaryTo.includes("chat"))
      await session.say(minutesForChat(state, config.agent.language));

    if (engines.embed) {
      try {
        const chunks = searchChunks(state, segments, minutes);
        const vectors = await engines.embed.embed(chunks.map((chunk) => chunk.text));
        store.addChunks(
          id,
          chunks
            .map((chunk, i) => ({ ...chunk, embedding: vectors[i] ?? [] }))
            .filter((chunk) => chunk.embedding.length),
        );
      } catch (error) {
        logger.warn(
          { meeting: id, error: String(error) },
          "could not index the meeting for search",
        );
      }
    }

    const { webhookUrl, postSummaryTo } = config.outputs;
    if (webhookUrl && postSummaryTo.includes("webhook")) {
      const current = store.getMeeting(id);
      await sendWebhook(
        webhookUrl,
        {
          event: "meeting.ended",
          meeting: {
            id,
            ...(record.title ? { title: record.title } : {}),
            ...(record.url ? { url: record.url } : {}),
            startedAt: record.startedAt,
            endedAt: new Date().toISOString(),
            costUsd: current?.costUsd ?? 0,
          },
          minutes,
          state,
        },
        this.fetchFn,
      ).catch((error: unknown) =>
        logger.warn({ meeting: id, error: String(error) }, "webhook failed"),
      );
    }
  }

  async command(
    id: string,
    text: string,
    options: { from?: string; commandId?: string; tools?: Tool[] } = {},
  ): Promise<void> {
    const live = this.live.get(id);
    if (!live) throw new Error("meeting is not live");
    const commandId = options.commandId ?? (options.tools ? randomUUID() : undefined);
    if (commandId && options.tools?.length) this.commandTools.set(commandId, options.tools);
    try {
      await live.session.submit(text, options.from ?? "panel", commandId);
    } finally {
      if (commandId) this.commandTools.delete(commandId);
    }
  }

  resolveApproval(id: string, approvalId: string, approved: boolean, by = "panel"): boolean {
    return this.live.get(id)?.session.resolveApproval(approvalId, approved, by) ?? false;
  }

  leave(id: string): boolean {
    const live = this.live.get(id);
    live?.session.leave("asked from the panel");
    return Boolean(live);
  }

  /** Removes a meeting and everything about it. A live meeting is left first. */
  async delete(id: string): Promise<boolean> {
    const live = this.live.get(id);
    if (live) {
      live.session.leave("deleted");
      await live.done;
    }
    return this.deps.store.deleteMeeting(id);
  }

  /** Deletes meetings older than the retention period. 0 days keeps everything. */
  purgeExpired(now = new Date()): number {
    const days = this.deps.config.consent.retentionDays;
    if (days <= 0) return 0;
    return this.deps.store.purgeBefore(new Date(now.getTime() - days * 86_400_000));
  }

  async shutdown(): Promise<void> {
    const running = [...this.live.values()];
    for (const live of running) live.session.leave("server shutting down");
    await Promise.allSettled(running.map((live) => live.done));
  }
}
