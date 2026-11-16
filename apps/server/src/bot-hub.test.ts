import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AsyncQueue,
  type BotJoinOptions,
  type CaptureEvent,
  type CaptureSource,
  DEFAULT_SESSION_OPTIONS,
  MeetingSession,
} from "@open-meetings/core";
import { createRuleLlm } from "@open-meetings/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { BotWorker } from "../../bot/src/worker";
import { BotHub } from "./bot-hub";

const JOIN: BotJoinOptions = {
  displayName: "Open Meetings (assistente IA)",
  headless: true,
  captureAudio: false,
  admissionTimeoutSec: 60,
};
const MEETING = { id: "m1", platform: "fake", url: "https://meet.example/abc" };

let onSent: ((text: string, queue: AsyncQueue<CaptureEvent>) => void) | undefined;
let spawn: (() => void) | undefined;

/** A scripted capture source standing in for a real browser. */
function fakeSource(script: CaptureEvent[]) {
  const queue = new AsyncQueue<CaptureEvent>();
  const sent: string[] = [];
  let stops = 0;
  const source: CaptureSource = {
    id: "fake",
    async *start() {
      for (const event of script) queue.push(event);
      yield* queue;
    },
    async sendChat(text) {
      if (text.includes("explode")) throw new Error("chat box not found");
      sent.push(text);
      onSent?.(text, queue);
    },
    async stop() {
      stops++;
      queue.close();
    },
  };
  return { source, sent, queue, stops: () => stops };
}

describe("BotHub <-> BotWorker", () => {
  let server: Server;
  let hub: BotHub;
  let url: string;
  const workers: BotWorker[] = [];

  function startWorker(source: CaptureSource, token = "secret") {
    const worker = new BotWorker({ url, token, platforms: { fake: () => source }, reconnectMs: 0 });
    workers.push(worker);
    worker.connect();
    return worker;
  }

  beforeEach(async () => {
    server = createServer();
    onSent = undefined;
    spawn = undefined;
    hub = new BotHub({
      token: "secret",
      workerTimeoutMs: 500,
      ackTimeoutMs: 500,
      spawnWorker: () => spawn?.(),
    });
    hub.attach(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/bot`;
  });
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.close()));
    hub.close();
    await new Promise((resolve) => server.close(resolve));
  });

  it("carries a whole meeting across the process boundary, chat replies included", async () => {
    const bot = fakeSource([
      { type: "participant", action: "joined", participant: { id: "ana", name: "Ana" }, atMs: 0 },
      {
        type: "transcript",
        segment: {
          id: "s1",
          speaker: "Ana",
          text: "Então fica decidido que usamos Postgres.",
          startMs: 1000,
          endMs: 3000,
          source: "captions",
        },
      },
      {
        type: "chat",
        message: { id: "c1", sender: "Ana", text: "om o que decidimos?", atMs: 4000 },
      },
    ]);
    // Ana asks the bot to leave only after reading its answer.
    onSent = (text, queue) => {
      if (!text.includes("Postgres")) return;
      queue.push({
        type: "chat",
        message: { id: "c2", sender: "Ana", text: "om sair", atMs: 9000 },
      });
    };
    startWorker(bot.source);
    const llm = createRuleLlm();
    const session = new MeetingSession(
      hub.createSource(JOIN),
      MEETING,
      { fast: llm, smart: llm },
      DEFAULT_SESSION_OPTIONS,
    );
    await session.run();

    expect(session.pipeline.state.decisions[0]?.text).toContain("Postgres");
    expect(bot.sent[0]).toContain("assistente de IA");
    expect(bot.sent.some((text) => text.includes("usamos Postgres"))).toBe(true);
    expect(bot.sent.at(-1)).toMatch(/Saindo/);
    await expect.poll(() => bot.stops()).toBeGreaterThan(0);
  });

  it("rejects a worker with the wrong token", async () => {
    const socket = new WebSocket(url, { headers: { authorization: "Bearer wrong" } });
    const outcome = await new Promise<string>((resolve) => {
      socket.on("open", () => resolve("open"));
      socket.on("error", (error) => resolve(error.message));
    });
    expect(outcome).toContain("401");
    expect(hub.workerCount).toBe(0);
  });

  it("fails clearly when no worker is available", async () => {
    const events = hub.createSource(JOIN).start(MEETING)[Symbol.asyncIterator]();
    await expect(events.next()).rejects.toThrow(/no bot worker is connected/);
  });

  it("starts a worker on demand", async () => {
    const bot = fakeSource([{ type: "ended", reason: "done" }]);
    spawn = () => startWorker(bot.source);
    const seen: string[] = [];
    for await (const event of hub.createSource(JOIN).start(MEETING)) {
      seen.push(event.type);
      if (event.type === "ended") break;
    }
    expect(seen).toEqual(["ended"]);
    expect(hub.workerCount).toBe(1);
  });

  it("ends the meeting, not the server, when the bot dies mid-call", async () => {
    const bot = fakeSource([
      { type: "participant", action: "joined", participant: { id: "ana", name: "Ana" }, atMs: 0 },
    ]);
    const worker = startWorker(bot.source);
    const seen: CaptureEvent[] = [];
    for await (const event of hub.createSource(JOIN).start(MEETING)) {
      seen.push(event);
      // A crash, not a goodbye: the socket just drops.
      if (event.type === "participant") worker.kill();
    }
    expect(seen.at(-1)).toEqual({ type: "ended", reason: "the bot disconnected" });
    expect(hub.workerCount).toBe(0);
  });

  it("reports a chat message the bot could not post", async () => {
    const bot = fakeSource([
      { type: "participant", action: "joined", participant: { id: "ana", name: "Ana" }, atMs: 0 },
    ]);
    startWorker(bot.source);
    const source = hub.createSource(JOIN);
    const events = source.start(MEETING)[Symbol.asyncIterator]();
    await events.next();
    await expect(source.sendChat?.("explode")).rejects.toThrow(/chat box not found/);
    await source.sendChat?.("tudo certo");
    expect(bot.sent).toEqual(["tudo certo"]);
    await source.stop();
  });

  it("reports an unsupported platform as a closed session", async () => {
    startWorker(fakeSource([]).source);
    const seen: CaptureEvent[] = [];
    for await (const event of hub.createSource(JOIN).start({ id: "z", platform: "zoom" }))
      seen.push(event);
    expect(seen).toEqual([{ type: "ended", reason: "unsupported platform: zoom" }]);
  });
});
