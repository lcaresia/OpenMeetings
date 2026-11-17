import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { parseConfig } from "@open-meetings/config";
import { createLogger, type Engines } from "@open-meetings/core";
import { createRuleLlm } from "@open-meetings/core/testing";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type App, startApp } from "../../server/src/app";
import { aguiRun, collect } from "../../server/src/testing";

const repo = join(import.meta.dirname, "../../..");
const hasBrowser = existsSync(chromium.executablePath());

/**
 * The whole chain with real processes: the server starts the bot process, the bot drives a
 * real Chromium into a (fake) Meet page, and the meeting comes back over the WebSocket link.
 */
describe.skipIf(!hasBrowser)("server + bot process + browser", () => {
  let meet: Server;
  let meetUrl: string;
  let app: App;

  beforeAll(async () => {
    const html = readFileSync(join(repo, "apps/bot/test/fake-meet.html"), "utf8");
    meet = createServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(html);
    });
    await new Promise<void>((resolve) => meet.listen(0, "127.0.0.1", resolve));
    meetUrl = `http://127.0.0.1:${(meet.address() as AddressInfo).port}/abc-defg-hij?autoplay=1`;

    process.env.OM_BOT_ENTRY = join(repo, "apps/bot/src/main.ts");
    const loaded = parseConfig(`
engines:
  llm:
    fast: { provider: openai-compatible, baseUrl: "http://localhost:1/v1", model: rule }
    smart: { provider: openai-compatible, baseUrl: "http://localhost:1/v1", model: rule }
storage: { driver: sqlite, path: ":memory:" }
bot: { admissionTimeoutSec: 20 }
`);
    const rule = createRuleLlm();
    const engines: Engines = { llm: { fast: rule, smart: rule } };
    app = await startApp(loaded, { engines, port: 0, logger: createLogger("test", "silent") });
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((resolve) => meet.close(resolve));
    delete process.env.OM_BOT_ENTRY;
  });

  it("joins, transcribes, answers in the chat, and saves the meeting", async () => {
    const res = await fetch(`${app.url}/api/meetings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: meetUrl, title: "Piloto", platform: "meet" }),
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };

    const events = await collect(aguiRun(app.url, { threadId: id }));
    const replies = events
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => String(event.delta));
    expect(replies.some((text) => text.includes("piloto começa em janeiro"))).toBe(true);

    await app.manager.getLive(id)?.done;
    const saved = app.manager.get(id);
    expect(saved?.status).toBe("ended");
    expect(saved?.state.decisions[0]?.text).toContain("janeiro");
    expect(saved?.state.participants.map((p) => p.name)).toEqual(["Ana Souza"]);
    expect(app.store.listSegments(id)).toMatchObject([
      { speaker: "Ana Souza", source: "captions" },
    ]);
  }, 90_000);
});
