import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  AsyncQueue,
  type BotCommand,
  type BotJoinOptions,
  type BotMessage,
  type CaptureEvent,
  type CaptureSource,
  fromWireEvent,
  type MeetingRef,
} from "@open-meetings/core";
import { type WebSocket, WebSocketServer } from "ws";

export type BotHubOptions = {
  /** Shared secret a worker must present. */
  token: string;
  /** Starts a worker process when none is connected (local mode). */
  spawnWorker?: () => void;
  workerTimeoutMs?: number;
  ackTimeoutMs?: number;
};

type Session = {
  worker: WebSocket;
  queue: AsyncQueue<CaptureEvent>;
  acks: Map<string, { resolve: () => void; reject: (error: Error) => void }>;
};

/**
 * The server side of the bot link. Bot workers connect here over WebSocket; each meeting gets
 * a `CaptureSource` that forwards to a worker. A worker crashing or disconnecting only ends
 * its own meetings: the server keeps running and reports the meeting as ended.
 */
export class BotHub {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly workers = new Set<WebSocket>();
  private readonly sessions = new Map<string, Session>();
  private waiters: (() => void)[] = [];

  constructor(private readonly options: BotHubOptions) {}

  /** Accepts worker connections on `path` of an existing HTTP server. */
  attach(server: Server, path = "/bot"): void {
    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== path) return;
      const presented =
        request.headers.authorization?.replace(/^Bearer /, "") ?? url.searchParams.get("token");
      if (presented !== this.options.token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => this.onWorker(ws));
    });
  }

  get workerCount(): number {
    return this.workers.size;
  }

  /** A capture source backed by a remote bot. The worker is picked when the meeting starts. */
  createSource(options: BotJoinOptions): CaptureSource {
    const sessionId = randomUUID();
    const hub = this;
    return {
      id: "meet-bot",
      async *start(meeting: MeetingRef) {
        const worker = await hub.acquireWorker();
        const session: Session = { worker, queue: new AsyncQueue(), acks: new Map() };
        hub.sessions.set(sessionId, session);
        hub.send(worker, { type: "join", sessionId, meeting, options });
        // The session stays registered after the consumer stops iterating, so a last chat
        // message (the goodbye, the minutes) can still go out. `stop()` ends it.
        yield* session.queue;
      },
      sendChat(text: string) {
        const session = hub.sessions.get(sessionId);
        if (!session) return Promise.reject(new Error("the bot is not in the meeting"));
        const requestId = randomUUID();
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            session.acks.delete(requestId);
            reject(new Error("the bot did not confirm the chat message"));
          }, hub.options.ackTimeoutMs ?? 15_000);
          session.acks.set(requestId, {
            resolve: () => {
              clearTimeout(timer);
              resolve();
            },
            reject: (error) => {
              clearTimeout(timer);
              reject(error);
            },
          });
          hub.send(session.worker, { type: "chat", sessionId, requestId, text });
        });
      },
      async stop() {
        const session = hub.sessions.get(sessionId);
        if (!session) return;
        hub.sessions.delete(sessionId);
        hub.send(session.worker, { type: "stop", sessionId });
        session.queue.close();
      },
    };
  }

  close(): void {
    for (const worker of this.workers) worker.close();
    this.wss.close();
  }

  private send(worker: WebSocket, command: BotCommand): void {
    worker.send(JSON.stringify(command));
  }

  private async acquireWorker(): Promise<WebSocket> {
    const [first] = this.workers;
    if (first) return first;
    this.options.spawnWorker?.();
    const timeoutMs = this.options.workerTimeoutMs ?? 30_000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter !== done);
        reject(new Error("no bot worker is connected (is the bot process running?)"));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(done);
    });
    const [worker] = this.workers;
    if (!worker) throw new Error("bot worker disconnected before the meeting started");
    return worker;
  }

  private endSessionsOf(worker: WebSocket, reason: string): void {
    for (const session of this.sessions.values()) {
      if (session.worker !== worker) continue;
      session.queue.push({ type: "ended", reason });
      session.queue.close();
      for (const ack of session.acks.values()) ack.reject(new Error(reason));
      session.acks.clear();
    }
  }

  private onWorker(ws: WebSocket): void {
    ws.on("message", (data) => {
      let message: BotMessage;
      try {
        message = JSON.parse(String(data)) as BotMessage;
      } catch {
        return;
      }
      if (message.type === "hello") {
        this.workers.add(ws);
        for (const waiter of this.waiters.splice(0)) waiter();
        return;
      }
      const session = this.sessions.get(message.sessionId);
      if (!session || session.worker !== ws) return;
      if (message.type === "event") {
        session.queue.push(fromWireEvent(message.event));
      } else if (message.type === "ack") {
        const ack = session.acks.get(message.requestId);
        session.acks.delete(message.requestId);
        if (message.error) ack?.reject(new Error(message.error));
        else ack?.resolve();
      } else {
        session.queue.push({ type: "ended", reason: message.reason });
        session.queue.close();
      }
    });
    ws.on("close", () => {
      this.workers.delete(ws);
      this.endSessionsOf(ws, "the bot disconnected");
    });
    ws.on("error", () => ws.close());
  }
}
