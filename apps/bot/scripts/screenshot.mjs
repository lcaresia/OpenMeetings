// Takes the README screenshot of the panel during a demo meeting.
// Needs a demo server: node apps/server/dist/main.js serve --demo weekly-sync --mock --speed 6
// Usage (from apps/bot): node scripts/screenshot.mjs http://127.0.0.1:4319 ../../docs/assets/panel.png
import { chromium } from "playwright";

const [base = "http://127.0.0.1:4319", out = "panel.png"] = process.argv.slice(2);
const meetings = await (await fetch(`${base}/api/meetings`)).json();
const live = meetings.find((m) => m.status === "live" || m.status === "joining") ?? meetings[0];
if (!live) throw new Error("no meeting to show");

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1360, height: 860 },
  colorScheme: "light",
  deviceScaleFactor: 2,
  locale: "pt-BR",
});
await page.goto(`${base}/meetings/${live.id}`);
await page.waitForSelector("text=Itens de ação");
// Let the meeting reach its decisions and action items.
await page.waitForFunction(
  () => document.body.innerText.includes("rodar o teste de usabilidade"),
  null,
  { timeout: 60_000 },
);
const ask = async (text) => {
  await page.fill('input[placeholder^="Peça algo"]', text);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
};
await ask("crie um cronograma");
await ask("crie um quadro");
await page.click("button:has-text('Transcrição')");
await page.waitForTimeout(800);
await page.screenshot({ path: out });
await page.click("button:has-text('Cronograma')");
await page.waitForTimeout(800);
await page.screenshot({ path: out.replace(/\.png$/, "-timeline.png") });
await browser.close();
console.log(`saved ${out}`);
