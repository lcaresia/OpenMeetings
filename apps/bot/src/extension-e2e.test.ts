import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserContext, chromium, type Worker } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../../server/src/app";
import { startTestApp } from "../../server/src/testing";

const repo = join(import.meta.dirname, "../../..");
const hasBrowser = existsSync(chromium.executablePath());

/**
 * The extension, unpacked into a real Chromium: its content script reads captions and chat
 * from a fake Meet tab, the offscreen document streams them to the server, and replies come
 * back to the extension. Tab audio (tabCapture) needs a real click on the toolbar button, which
 * automation cannot give, so this runs captions-only.
 */
describe.skipIf(!hasBrowser)("browser extension in Chromium", () => {
  let meet: Server;
  let meetUrl: string;
  let app: App;
  let context: BrowserContext;
  let worker: Worker;

  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), "om-extension-"));
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(repo, "apps/extension/build.ts"),
        "--out",
        out,
        "--match",
        "http://127.0.0.1/*",
      ],
      { cwd: repo, stdio: "pipe" },
    );

    const html = readFileSync(join(repo, "apps/bot/test/fake-meet.html"), "utf8");
    meet = createServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(html);
    });
    await new Promise<void>((resolve) => meet.listen(0, "127.0.0.1", resolve));
    meetUrl = `http://127.0.0.1:${(meet.address() as AddressInfo).port}/abc-defg-hij?incall=1&autoplay=1`;
    app = await startTestApp();

    context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "om-profile-")), {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${out}`, `--load-extension=${out}`],
    });
    worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  });

  afterAll(async () => {
    await context?.close();
    await app?.close();
    await new Promise((resolve) => meet.close(resolve));
  });

  it("captures captions and chat from the tab and gets replies back", async () => {
    await worker.evaluate(`chrome.storage.local.set({ server: ${JSON.stringify(app.url)} })`);
    const page = await context.newPage();
    await page.goto(meetUrl);
    await page.waitForTimeout(500);
    await worker.evaluate(`(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await globalThis.omStart({ tabId: tab.id, audio: false, title: "Sem bot" });
    })()`);

    // The page plays: a decision in the captions, then "om o que decidimos?" in the chat.
    let replies: string[] = [];
    for (let i = 0; i < 60 && !replies.some((r) => r.includes("janeiro")); i++) {
      await page.waitForTimeout(250);
      replies = (await worker.evaluate(
        `chrome.storage.session.get("status").then(({ status }) => status?.replies ?? [])`,
      )) as string[];
    }
    expect(replies.some((reply) => reply.includes("piloto começa em janeiro"))).toBe(true);

    await worker.evaluate("globalThis.omStop()");
    let status: { state?: string; meetingId?: string } = {};
    for (let i = 0; i < 40 && status.state !== "ended"; i++) {
      await page.waitForTimeout(250);
      status = (await worker.evaluate(
        `chrome.storage.session.get("status").then(({ status }) => status ?? {})`,
      )) as typeof status;
    }
    expect(status.state).toBe("ended");

    const saved = app.manager.get(String(status.meetingId));
    expect(saved).toMatchObject({ status: "ended", title: "Sem bot" });
    expect(saved?.state.decisions[0]?.text).toContain("janeiro");
    expect(app.store.listSegments(String(status.meetingId))[0]).toMatchObject({
      speaker: "Ana Souza",
      source: "captions",
    });
  }, 60_000);
});
