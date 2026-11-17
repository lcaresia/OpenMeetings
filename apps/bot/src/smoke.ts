#!/usr/bin/env node
/**
 * Live selector smoke test: opens a real Google Meet link and checks that the pre-join
 * selectors still match. It never asks to join, so nobody has to admit it and it can run
 * unattended (see .github/workflows/selectors-smoke.yml).
 *
 * Usage: OM_SMOKE_MEET_URL=https://meet.google.com/xxx-yyyy-zzz pnpm --filter @open-meetings/bot smoke
 */
import { chromium } from "playwright";
import { withUiLanguage } from "./meet/meet-source";
import { SELECTORS } from "./meet/selectors";

type Check = { name: string; ok: boolean; matched?: string };

async function main(): Promise<number> {
  const url = process.env.OM_SMOKE_MEET_URL;
  if (!url) {
    console.error("OM_SMOKE_MEET_URL is not set");
    return 2;
  }
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });
  const context = await browser.newContext({
    locale: "en-US",
    ...(process.env.OM_SMOKE_STORAGE_STATE
      ? { storageState: process.env.OM_SMOKE_STORAGE_STATE }
      : {}),
  });
  const page = await context.newPage();
  const checks: Check[] = [];
  try {
    await page.goto(withUiLanguage(url), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(8000);
    const probe = async (name: string, list: readonly string[]) => {
      for (const selector of list) {
        if (
          await page
            .locator(selector)
            .first()
            .isVisible()
            .catch(() => false)
        ) {
          checks.push({ name, ok: true, matched: selector });
          return;
        }
      }
      checks.push({ name, ok: false });
    };
    // A signed-in profile has no name field; a guest must have one.
    if (!process.env.OM_SMOKE_STORAGE_STATE)
      await probe("preJoin.nameInput", SELECTORS.preJoin.nameInput);
    await probe("preJoin.joinButton", SELECTORS.preJoin.joinButton);
    await probe("preJoin.micOff", SELECTORS.preJoin.micOff);
    await probe("preJoin.camOff", SELECTORS.preJoin.camOff);
    const visible = await page.evaluate("document.body.innerText").catch(() => "");
    const body = String(visible).slice(0, 400);
    const blocked = SELECTORS.states.blocked.some((text) => body.includes(text));
    console.log(
      JSON.stringify({ url: new URL(url).pathname, blocked, checks, pageText: body }, null, 2),
    );
    if (blocked) return 3;
    return checks.every((check) => check.ok) ? 0 : 1;
  } finally {
    await browser.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
