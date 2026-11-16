import { randomUUID } from "node:crypto";
import {
  type BotCommand,
  type BotJoinOptions,
  type BotMessage,
  type CaptureSource,
  type MeetingRef,
  toWireEvent,
} from "@open-meetings/core";
import WebSocket from "ws";

export type SourceFactory = (meeting: MeetingRef, options: BotJoinOptions) => CaptureSource;

export type WorkerOptions = {
  url: string;
  token: string;
  /** One factory per platform id ("meet", ...). */
  platforms: Record<string, SourceFactory>;
  log?: (message: string, extra?: Record<string, unknown>) => void;
  /** Reconnect delay; set to 0 to disable reconnection (tests). */
  reconnectMs?: number;
};

/**
 * Connects to the server and runs one capture source (one browser) per meeting it is asked
 * to join. Sources are isolated from each other: one failing reports `closed` for its own
 * session and nothing else.
 */
export class BotWorker {
  private socket?: WebSocket;
  private readonly sources = new Map<string, CaptureSource>();
  private stopped = false;

  constructor(private readonly options: WorkerOptions) {}

  connect(): void {
    const { url, token, platforms, reconnectMs = 2000 } = this.options;
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    this.socket = socket;
    socket.on("open", () => {
      this.options.log?.("connected to server", { url });
      this.send({ type: "hello", workerId: randomUUID(), platforms: Object.keys(platforms) });
    });
    socket.on("message", (data) => {
      try {
        this.onCommand(JSON.parse(String(data)) as BotCommand);
      } catch (error) {
        this.options.log?.("bad command", { error: String(error) });
      }
    });
    socket.on("error", (error) => this.options.log?.("socket error", { error: error.message }));
    socket.on("close", () => {
      // The server is gone: nobody is listening, so leave every meeting.
      void this.stopAll();
      if (!this.stopped && reconnectMs > 0) setTimeout(() => this.connect(), reconnectMs);
    });
  }

  async close(): Promise<void> {
    this.stopped = true;
    await this.stopAll();
    this.socket?.close();
  }

  /** Drops the connection with no goodbye, as a crash would. */
  kill(): void {
    this.stopped = true;
    this.socket?.terminate();
  }

  private send(message: BotMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private async stopAll(): Promise<void> {
    const sources = [...this.sources.values()];
    this.sources.clear();
    await Promise.allSettled(sources.map((source) => source.stop()));
  }

  private onCommand(command: BotCommand): void {
    const { sessionId } = command;
    if (command.type === "join") {
      void this.run(sessionId, command.meeting, command.options);
    } else if (command.type === "chat") {
      const source = this.sources.get(sessionId);
      const done = (error?: string) =>
        this.send({
          type: "ack",
          sessionId,
          requestId: command.requestId,
          ...(error ? { error } : {}),
        });
      if (!source?.sendChat) done("this session cannot send chat messages");
      else
        source.sendChat(command.text).then(
          () => done(),
          (error: unknown) => done(String(error)),
        );
    } else {
      const source = this.sources.get(sessionId);
      this.sources.delete(sessionId);
      void source?.stop();
    }
  }

  private async run(
    sessionId: string,
    meeting: MeetingRef,
    options: BotJoinOptions,
  ): Promise<void> {
    const factory = this.options.platforms[meeting.platform];
    if (!factory) {
      this.send({
        type: "closed",
        sessionId,
        reason: `unsupported platform: ${meeting.platform}`,
        error: true,
      });
      return;
    }
    const source = factory(meeting, options);
    this.sources.set(sessionId, source);
    try {
      for await (const event of source.start(meeting)) {
        this.send({ type: "event", sessionId, event: toWireEvent(event) });
      }
      this.send({ type: "closed", sessionId, reason: "left the meeting" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.log?.("session failed", { sessionId, reason });
      this.send({ type: "closed", sessionId, reason, error: true });
    } finally {
      this.sources.delete(sessionId);
      await source.stop().catch(() => undefined);
    }
  }
}
