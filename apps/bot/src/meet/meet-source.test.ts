import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  type BotJoinOptions,
  type CaptureEvent,
  DEFAULT_SESSION_OPTIONS,
  MeetingSession,
} from "@open-meetings/core";
import { createRuleLlm } from "@open-meetings/core/testing";
import { chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMeetSource, MeetJoinError, withUiLanguage } from "./meet-source";

const html = readFileSync(join(import.meta.dirname, "../../test/fake-meet.html"), "utf8");
const hasBrowser = existsSync(chromium.executablePath());

const OPTIONS: BotJoinOptions = {
  displayName: "Open Meetings (assistente IA)",
  headless: true,
  captureAudio: false,
  admissionTimeoutSec: 10,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs a snippet against the fake page's `fakeMeet` hooks. Snippets are strings so they run
 * in the browser exactly as written (no Node types, no bundler helpers).
 */
const meet = (page: Page, snippet: string) => page.evaluate(`(async () => { ${snippet} })()`);

describe("withUiLanguage", () => {
  it("pins English and keeps an explicit choice", () => {
    expect(withUiLanguage("https://meet.google.com/abc-defg-hij")).toBe(
      "https://meet.google.com/abc-defg-hij?hl=en",
    );
    expect(withUiLanguage("https://meet.google.com/abc?hl=pt-BR")).toContain("hl=pt-BR");
  });
});

describe.skipIf(!hasBrowser)("Meet bot against a fake Meet page", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/abc-defg-hij`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  /** Starts the bot and plays `scene` on the page once the bot is in the call and watching. */
  function startBot(url: string, scene: (page: Page) => Promise<void>) {
    let page: Page | undefined;
    const source = createMeetSource({ id: "m", platform: "meet", url }, OPTIONS, {
      onPage: (p) => {
        page = p;
      },
      pollMs: 200,
    });
    const run = async () => {
      while (!(page && (await meet(page, "return '__omObserver' in window").catch(() => false)))) {
        await sleep(100);
      }
      await scene(page);
    };
    return { source, run, page: () => page };
  }

  it("joins, turns captions on, turns rewritten captions into segments, and leaves", async () => {
    const bot = startBot(base, async (page) => {
      await meet(page, "fakeMeet.join('ana', 'Ana Souza')");
      await meet(
        page,
        `const wait = (ms) => new Promise((r) => setTimeout(r, ms));
         const block = fakeMeet.speak("Ana Souza");
         for (const text of ["Então", "Então fica", "Então fica decidido que",
                             "Então fica decidido que lançamos em dezembro."]) {
           fakeMeet.say(block, text);
           await wait(120);
         }
         await wait(1500);
         fakeMeet.chat("Ana Souza", "om o que decidimos?");`,
      );
      await sleep(1500);
      await meet(page, "fakeMeet.chat('Ana Souza', 'om sair')");
    });

    const llm = createRuleLlm();
    const session = new MeetingSession(
      bot.source,
      { id: "m", platform: "meet", url: base },
      { fast: llm, smart: llm },
      DEFAULT_SESSION_OPTIONS,
    );
    const replies: string[] = [];
    let commands = 0;
    session.on((event) => {
      if (event.type === "reply") replies.push(event.text);
      if (event.type === "command") commands++;
    });
    await Promise.all([session.run(), bot.run()]);

    expect(session.pipeline.segments).toHaveLength(1);
    expect(session.pipeline.segments[0]).toMatchObject({
      speaker: "Ana Souza",
      text: "Então fica decidido que lançamos em dezembro.",
      source: "captions",
    });
    expect(session.pipeline.state.decisions[0]?.text).toContain("dezembro");
    expect(session.pipeline.state.participants.map((p) => p.name)).toEqual(["Ana Souza"]);
    expect(commands).toBe(2);
    expect(replies.some((text) => text.includes("lançamos em dezembro"))).toBe(true);
    expect(session.status).toBe("left");
    expect(bot.page()?.isClosed()).toBe(true);
  }, 30_000);

  it("posts in the call chat, joined under its own name, with camera and mic off", async () => {
    const bot = startBot(base, async () => undefined);
    const iterator = bot.source
      .start({ id: "m", platform: "meet", url: base })
      [Symbol.asyncIterator]();
    const first = iterator.next();
    await bot.run();
    await bot.source.sendChat?.("Olá, sou o Open Meetings.");
    const page = bot.page();
    const state = page
      ? await meet(
          page,
          `return { ...fakeMeet.state,
             mic: document.getElementById("mic").getAttribute("aria-label"),
             cam: document.getElementById("cam").getAttribute("aria-label") };`,
        )
      : undefined;
    expect(state).toMatchObject({
      name: OPTIONS.displayName,
      hl: "en",
      sent: ["Olá, sou o Open Meetings."],
      mic: "Turn on microphone",
      cam: "Turn on camera",
    });
    // Our own message comes back from the DOM tagged with our name, so the session ignores it.
    expect((await first).value as CaptureEvent).toMatchObject({
      type: "chat",
      message: { sender: OPTIONS.displayName, text: "Olá, sou o Open Meetings." },
    });
    await bot.source.stop();
  }, 30_000);

  it("reports a refused admission as a join error", async () => {
    const source = createMeetSource({ id: "m", platform: "meet", url: `${base}?deny=1` }, OPTIONS);
    const iterator = source.start({ id: "m", platform: "meet" })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBeInstanceOf(MeetJoinError);
    await source.stop();
  }, 30_000);

  it("ends the capture when the host ends the meeting", async () => {
    const bot = startBot(base, (page) => meet(page, "fakeMeet.end()").then(() => undefined));
    const seen: CaptureEvent[] = [];
    await Promise.all([
      (async () => {
        for await (const event of bot.source.start({ id: "m", platform: "meet", url: base })) {
          seen.push(event);
        }
      })(),
      bot.run(),
    ]);
    expect(seen.at(-1)).toEqual({ type: "ended", reason: "the meeting ended" });
  }, 30_000);
});
