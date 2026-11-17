import {
  AsyncQueue,
  type BotJoinOptions,
  CaptionStabilizer,
  type CaptureEvent,
  type CaptureSource,
  type MeetingRef,
  type Participant,
} from "@open-meetings/core";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import {
  AUDIO_SCRIPT,
  OBSERVER_SCRIPT,
  PARTICIPANTS_SCRIPT,
  type PageMessage,
} from "./page-script";
import { pageSelectors, SELECTORS } from "./selectors";

export class MeetJoinError extends Error {
  constructor(
    readonly reason:
      | "denied"
      | "no-response"
      | "not-found"
      | "blocked"
      | "timeout"
      | "no-join-button",
    message: string,
  ) {
    super(message);
    this.name = "MeetJoinError";
  }
}

export type MeetSourceDeps = {
  /** Replaces the browser launch (tests). */
  launch?: (options: BotJoinOptions) => Promise<Browser>;
  /** Called once the page exists (tests drive a fake Meet through it). */
  onPage?: (page: Page) => void;
  log?: (message: string, extra?: Record<string, unknown>) => void;
  pollMs?: number;
};

/** Pins the Meet UI language, so the English text fallbacks in selectors.ts apply. */
export function withUiLanguage(url: string, language = "en"): string {
  const parsed = new URL(url);
  if (!parsed.searchParams.has("hl")) parsed.searchParams.set("hl", language);
  return parsed.toString();
}

/** Clicks the first selector of the list that is visible now. */
async function clickFirst(
  page: Page,
  selectors: readonly string[],
  timeoutMs = 0,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const selector of selectors) {
      const target = page.locator(selector).first();
      if (await target.isVisible().catch(() => false)) {
        await target.click({ timeout: 5000 }).catch(() => undefined);
        return true;
      }
    }
    if (Date.now() < deadline) await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  return false;
}

async function anyVisible(page: Page, selectors: readonly string[]): Promise<boolean> {
  for (const selector of selectors) {
    if (
      await page
        .locator(selector)
        .first()
        .isVisible()
        .catch(() => false)
    )
      return true;
  }
  return false;
}

async function pageHas(page: Page, phrases: readonly string[]): Promise<boolean> {
  // innerText, not textContent: Meet keeps hidden lobby text in the DOM after admission.
  const text = await page.evaluate("document.body.innerText").catch(() => "");
  const body = String(text).toLowerCase();
  return phrases.some((phrase) => body.includes(phrase.toLowerCase()));
}

const defaultLaunch = (options: BotJoinOptions) =>
  chromium.launch({
    headless: options.headless,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

/**
 * Google Meet through a real browser. Joins as a guest (or with a saved account), turns its
 * own camera and microphone off, waits to be admitted, turns captions on, and turns what
 * appears on screen into capture events.
 */
export function createMeetSource(
  meeting: MeetingRef,
  options: BotJoinOptions,
  deps: MeetSourceDeps = {},
): CaptureSource {
  const log = deps.log ?? (() => undefined);
  const pollMs = deps.pollMs ?? 2000;
  const queue = new AsyncQueue<CaptureEvent>();
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let stabilizer: CaptionStabilizer | undefined;
  let timers: ReturnType<typeof setInterval>[] = [];
  let startedAt = 0;
  let stopped = false;
  let chatChain: Promise<void> = Promise.resolve();
  const sentByUs: string[] = [];
  const clock = () => (startedAt ? Date.now() - startedAt : 0);

  function onPageMessage(message: PageMessage): void {
    if (message.kind === "caption") stabilizer?.update(message.key, message.speaker, message.text);
    else if (message.kind === "caption-removed") stabilizer?.remove(message.key);
    else if (message.kind === "chat") {
      const own = (SELECTORS.chat.selfLabels as readonly string[]).includes(message.sender);
      const echo = sentByUs.indexOf(message.text);
      if (own || echo !== -1) {
        if (echo !== -1) sentByUs.splice(echo, 1);
        // Our own message: reported under our name so the session can ignore it.
        queue.push({
          type: "chat",
          message: {
            id: message.id,
            sender: options.displayName,
            text: message.text,
            atMs: clock(),
          },
        });
        return;
      }
      queue.push({
        type: "chat",
        message: { id: message.id, sender: message.sender, text: message.text, atMs: clock() },
      });
    } else {
      const bytes = Buffer.from(message.pcmBase64, "base64");
      const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
      queue.push({
        type: "audio",
        chunk: { pcm, sampleRate: message.sampleRate, startMs: clock() - 1000 },
      });
    }
  }

  async function preJoin(target: Page): Promise<void> {
    await clickFirst(target, SELECTORS.preJoin.dismiss, 1500);
    const name = target.locator(SELECTORS.preJoin.nameInput.join(", ")).first();
    if (await name.isVisible({ timeout: 10_000 }).catch(() => false)) {
      await name.fill(options.displayName);
    }
    await clickFirst(target, SELECTORS.preJoin.micOff);
    await clickFirst(target, SELECTORS.preJoin.camOff);
    if (!(await clickFirst(target, SELECTORS.preJoin.joinButton, 15_000))) {
      throw new MeetJoinError(
        "no-join-button",
        "could not find the join button (see apps/bot/src/meet/selectors.ts)",
      );
    }
  }

  async function waitForAdmission(target: Page): Promise<void> {
    const deadline = Date.now() + options.admissionTimeoutSec * 1000;
    const { states } = SELECTORS;
    while (Date.now() < deadline) {
      if (await pageHas(target, states.denied))
        throw new MeetJoinError("denied", "the host denied the request to join");
      if (await pageHas(target, states.noResponse))
        throw new MeetJoinError("no-response", "no one admitted the bot");
      if (await pageHas(target, states.notFound))
        throw new MeetJoinError("not-found", "the meeting does not exist");
      if (await pageHas(target, states.blocked)) {
        throw new MeetJoinError(
          "blocked",
          'Meet refused this browser ("You can\'t join this video call")',
        );
      }
      const waiting = await pageHas(target, states.waiting);
      const inside = await target
        .evaluate(`${JSON.stringify(SELECTORS.admitted)}.some((s) => document.querySelector(s))`)
        .catch(() => false);
      if (inside && !waiting) return;
      await target.waitForTimeout(500);
    }
    throw new MeetJoinError("timeout", `not admitted within ${options.admissionTimeoutSec} s`);
  }

  async function enableCaptions(target: Page): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt++) {
      if (await anyVisible(target, SELECTORS.captions.isOn)) return;
      if (await pageHas(target, SELECTORS.states.ended)) return;
      if (!(await clickFirst(target, SELECTORS.captions.turnOn))) {
        await target.keyboard.press(SELECTORS.captions.shortcut).catch(() => undefined);
      }
      await target.waitForTimeout(1500);
    }
    log("captions could not be turned on; transcript will be empty unless STT is configured");
  }

  async function openChat(target: Page): Promise<void> {
    if (await anyVisible(target, SELECTORS.chat.input)) return;
    await clickFirst(target, SELECTORS.chat.open, 5000);
  }

  function watchParticipants(target: Page): void {
    const present = new Map<string, Participant>();
    const poll = async () => {
      const seen = (await target
        .evaluate(`(${PARTICIPANTS_SCRIPT})(${JSON.stringify(pageSelectors())})`)
        .catch(() => undefined)) as Participant[] | undefined;
      if (!seen) return;
      const ids = new Set(seen.map((person) => person.id));
      for (const person of seen) {
        if (present.has(person.id)) continue;
        present.set(person.id, person);
        queue.push({ type: "participant", action: "joined", participant: person, atMs: clock() });
      }
      for (const [id, person] of present) {
        if (ids.has(id)) continue;
        present.delete(id);
        queue.push({ type: "participant", action: "left", participant: person, atMs: clock() });
      }
    };
    void poll();
    timers.push(setInterval(() => void poll(), pollMs));
  }

  function watchEnd(target: Page): void {
    timers.push(
      setInterval(async () => {
        if (stopped || !(await pageHas(target, SELECTORS.states.ended))) return;
        finish("the meeting ended");
      }, pollMs),
    );
    target.on("close", () => finish("the browser tab closed"));
  }

  function finish(reason: string): void {
    if (stopped) return;
    stabilizer?.flush();
    queue.push({ type: "ended", reason });
    void source.stop();
  }

  const source: CaptureSource = {
    id: "meet-bot",

    async *start(): AsyncGenerator<CaptureEvent> {
      if (!meeting.url) throw new Error("a Google Meet link is required");
      browser = await (deps.launch ?? defaultLaunch)(options);
      context = await browser.newContext({
        locale: "en-US",
        viewport: { width: 1280, height: 800 },
        ...(options.storageState ? { storageState: options.storageState } : {}),
      });
      await context.exposeBinding("__omEmit", (_source, message: PageMessage) =>
        onPageMessage(message),
      );
      if (options.captureAudio) await context.addInitScript(AUDIO_SCRIPT);
      page = await context.newPage();
      deps.onPage?.(page);

      log("opening meeting", { meeting: meeting.id });
      await page.goto(withUiLanguage(meeting.url), { waitUntil: "domcontentloaded" });
      await preJoin(page);
      log("waiting for admission");
      await waitForAdmission(page);
      startedAt = Date.now();
      log("admitted");

      stabilizer = new CaptionStabilizer({
        clock,
        onSegment: (segment) => queue.push({ type: "transcript", segment }),
        ...(options.captionsLanguage ? { language: options.captionsLanguage } : {}),
      });
      await enableCaptions(page);
      await openChat(page);
      await page.evaluate(`(${OBSERVER_SCRIPT})(${JSON.stringify(pageSelectors())})`);
      watchParticipants(page);
      watchEnd(page);
      yield* queue;
    },

    sendChat(text: string): Promise<void> {
      const run = chatChain.then(async () => {
        if (!page || stopped) throw new Error("the bot is not in the meeting");
        await openChat(page);
        const input = page.locator(SELECTORS.chat.input.join(", ")).first();
        await input.fill(text, { timeout: 5000 });
        sentByUs.push(text.replace(/\s+/g, " ").trim());
        await input.press("Enter");
      });
      chatChain = run.catch(() => undefined);
      return run;
    },

    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      for (const timer of timers) clearInterval(timer);
      timers = [];
      stabilizer?.flush();
      queue.close();
      // Let a last chat message (the goodbye) go out before hanging up.
      await chatChain;
      if (page && !page.isClosed()) await clickFirst(page, SELECTORS.leave).catch(() => false);
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    },
  };
  return source;
}
