import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  AsyncQueue,
  CaptionStabilizer,
  type CaptureEvent,
  type CaptureSource,
  type Logger,
} from "@open-meetings/core";
import { type WebSocket, WebSocketServer } from "ws";
import { authorized } from "./http";
import type { MeetingManager } from "./manager";

/**
 * Messages from the browser extension. Audio travels as binary frames: 16 kHz mono PCM16 LE.
 */
export type ExtensionMessage =
  | { type: "start"; url?: string; title?: string; platform?: string }
  | { type: "caption"; key: string; speaker: string; text: string }
  | { type: "caption-removed"; key: string }
  /** A message typed in the call's chat, so `om sair` and `om pausar` work without a bot. */
  | { type: "chat"; id: string; sender: string; text: string }
  | { type: "stop" };

export type ExtensionReply =
  | { type: "started"; meetingId: string }
  | { type: "reply"; text: string }
  | { type: "ended"; reason: string }
  | { type: "error"; message: string };

/** While captions keep arriving, audio is not transcribed: the captions already cover it. */
const CAPTIONS_WIN_MS = 10_000;

/** A capture source fed by one extension connection. */
export function extensionSource(
  ws: WebSocket,
): CaptureSource & { ready: Promise<ExtensionMessage & { type: "start" }> } {
  const queue = new AsyncQueue<CaptureEvent>();
  const startedAt = Date.now();
  const clock = () => Date.now() - startedAt;
  let lastCaption = Number.NEGATIVE_INFINITY;
  const stabilizer = new CaptionStabilizer({
    clock,
    onSegment: (segment) => queue.push({ type: "transcript", segment }),
  });
  let resolveStart: (message: ExtensionMessage & { type: "start" }) => void = () => undefined;
  const ready = new Promise<ExtensionMessage & { type: "start" }>((resolve) => {
    resolveStart = resolve;
  });

  ws.on("message", (data, binary) => {
    if (binary) {
      if (clock() - lastCaption < CAPTIONS_WIN_MS) return;
      const bytes = data as Buffer;
      const copy = Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2)));
      const pcm = new Int16Array(copy.buffer, copy.byteOffset, copy.length / 2);
      queue.push({
        type: "audio",
        chunk: { pcm, sampleRate: 16000, startMs: clock() - pcm.length / 16 },
      });
      return;
    }
    let message: ExtensionMessage;
    try {
      message = JSON.parse(String(data)) as ExtensionMessage;
    } catch {
      return;
    }
    if (message.type === "start") resolveStart(message);
    else if (message.type === "caption") {
      lastCaption = clock();
      stabilizer.update(message.key, message.speaker, message.text);
    } else if (message.type === "caption-removed") stabilizer.remove(message.key);
    else if (message.type === "chat") {
      queue.push({
        type: "chat",
        message: { id: message.id, sender: message.sender, text: message.text, atMs: clock() },
      });
    } else {
      stabilizer.flush();
      queue.push({ type: "ended", reason: "capture stopped in the browser" });
      queue.close();
    }
  });
  ws.on("close", () => {
    stabilizer.flush();
    queue.push({ type: "ended", reason: "the browser extension disconnected" });
    queue.close();
  });

  return {
    id: "extension",
    ready,
    async *start() {
      yield* queue;
    },
    async stop() {
      // The socket stays open: the hub tells the extension the meeting ended, then closes it.
      queue.close();
    },
  };
}

/** Accepts extension connections on `/capture` and turns each into a meeting. */
export function attachCaptureHub(
  server: Server,
  options: { manager: MeetingManager; token?: string; logger: Logger; path?: string },
): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const path = options.path ?? "/capture";

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== path) return;
    if (!authorized(request, options.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => void accept(ws));
  });

  async function accept(ws: WebSocket): Promise<void> {
    const send = (reply: ExtensionReply) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(reply));
    };
    const source = extensionSource(ws);
    const start = await Promise.race([
      source.ready,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 10_000)),
    ]);
    if (!start) {
      send({ type: "error", message: "expected a start message" });
      ws.close();
      return;
    }
    try {
      const live = options.manager.start({
        source,
        platform: start.platform ?? "extension",
        ...(start.url ? { url: start.url } : {}),
        ...(start.title ? { title: start.title } : {}),
      });
      const id = live.record.id;
      send({ type: "started", meetingId: id });
      const unsubscribe = options.manager.subscribe(id, (event) => {
        if (event.type === "reply") send({ type: "reply", text: event.text });
        if (event.type === "closed") {
          send({ type: "ended", reason: event.reason });
          unsubscribe();
          ws.close();
        }
      });
      options.logger.info({ meeting: id }, "browser extension capture started");
    } catch (error) {
      send({ type: "error", message: (error as Error).message });
      ws.close();
    }
  }

  return () => {
    // Shutting down: connections that never started a meeting would keep the server open.
    for (const client of wss.clients) client.terminate();
    wss.close();
  };
}
