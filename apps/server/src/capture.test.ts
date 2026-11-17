import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pcm16ToWav } from "@open-meetings/engines";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { App } from "./app";
import { readWav } from "./file-source";
import { fakeStt, startTestApp } from "./testing";

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** A tone, so the audio is not trivially silent. */
function tone(seconds: number, rate = 16000): Int16Array {
  const pcm = new Int16Array(seconds * rate);
  for (let i = 0; i < pcm.length; i++)
    pcm[i] = Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 8000);
  return pcm;
}

async function waitEnded(target: App, id: string) {
  await target.manager.getLive(id)?.done;
  return target.manager.get(id);
}

describe("file uploads", () => {
  it("transcribes a WAV recording in windows and closes the meeting with minutes", async () => {
    const stt = fakeStt();
    app = await startTestApp({ stt });
    const wav = pcm16ToWav(tone(20), 16000);
    const res = await fetch(`${app.url}/api/meetings/upload?filename=reuniao.wav&title=Gravada`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: wav,
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const saved = await waitEnded(app, id);

    expect(saved).toMatchObject({ status: "ended", title: "Gravada", platform: "file" });
    expect(stt.windows.map((w) => Math.round(w.seconds))).toEqual([8, 8, 4]);
    expect(stt.windows.map((w) => w.startMs)).toEqual([0, 8000, 16000]);
    // Without diarization every window has the same speaker, so the pipeline joins them.
    expect(app.store.listSegments(id).map((s) => s.text)).toEqual([
      "Trecho 1 transcrito. Trecho 2 transcrito. Trecho 3 transcrito.",
    ]);
    expect(saved?.minutes).toContain("# Ata");
  });

  const hasFfmpeg = !spawnSync("ffmpeg", ["-version"]).error;

  it.skipIf(!hasFfmpeg)("decodes other formats with ffmpeg", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-mp3-"));
    const mp3 = join(dir, "a.mp3");
    const made = spawnSync("ffmpeg", [
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=10",
      "-ar",
      "44100",
      "-ac",
      "2",
      mp3,
    ]);
    expect(made.status).toBe(0);
    const stt = fakeStt();
    app = await startTestApp({ stt });
    const res = await fetch(`${app.url}/api/meetings/upload?filename=a.mp3`, {
      method: "POST",
      headers: { "content-type": "audio/mpeg" },
      body: readFileSync(mp3),
    });
    const { id } = (await res.json()) as { id: string };
    const saved = await waitEnded(app, id);
    expect(saved?.status).toBe("ended");
    const seconds = stt.windows.reduce((sum, w) => sum + w.seconds, 0);
    expect(seconds).toBeGreaterThan(9.5);
    expect(seconds).toBeLessThan(10.5);
    expect(stt.windows.every((w) => w.sampleRate === 16000)).toBe(true);
  });

  it("refuses uploads when no speech-to-text engine is configured", async () => {
    app = await startTestApp();
    const res = await fetch(`${app.url}/api/meetings/upload`, {
      method: "POST",
      body: new Uint8Array(10),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("speech-to-text");
  });

  it("reads 16-bit WAV without ffmpeg, mixing stereo down", () => {
    const stereo = Buffer.from(pcm16ToWav(new Int16Array([100, 300, -50, 50]), 8000));
    stereo.writeUInt16LE(2, 22); // channels
    const { pcm, sampleRate } = readWav(stereo);
    expect(sampleRate).toBe(8000);
    expect([...pcm]).toEqual([200, 0]);
  });
});

describe("browser extension capture", () => {
  function connect(target: App, token?: string) {
    const ws = new WebSocket(`${target.url.replace("http", "ws")}/capture`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    const replies: Record<string, unknown>[] = [];
    const waiting: {
      test: (r: Record<string, unknown>) => boolean;
      resolve: (r: Record<string, unknown>) => void;
    }[] = [];
    ws.on("message", (data) => {
      const reply = JSON.parse(String(data)) as Record<string, unknown>;
      replies.push(reply);
      for (const w of [...waiting]) {
        if (w.test(reply)) {
          waiting.splice(waiting.indexOf(w), 1);
          w.resolve(reply);
        }
      }
    });
    const next = (test: (r: Record<string, unknown>) => boolean) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const found = replies.find(test);
        if (found) resolve(found);
        else waiting.push({ test, resolve });
      });
    const opened = new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    const send = (message: unknown) => ws.send(JSON.stringify(message));
    return { ws, replies, next, opened, send };
  }

  it("turns captions from the page into a meeting and sends replies back", async () => {
    const stt = fakeStt();
    app = await startTestApp({ stt });
    const ext = connect(app);
    await ext.opened;
    ext.send({
      type: "start",
      url: "https://meet.google.com/abc-defg-hij",
      title: "Sem bot",
      platform: "meet",
    });
    const started = await ext.next((r) => r.type === "started");
    const id = String(started.meetingId);

    ext.send({ type: "caption", key: "1", speaker: "Ana", text: "Então fica decidido que" });
    ext.send({
      type: "caption",
      key: "1",
      speaker: "Ana",
      text: "Então fica decidido que usamos o plano B.",
    });
    // Tab audio while captions are flowing is redundant and must not be transcribed.
    ext.ws.send(Buffer.from(tone(2).buffer));
    ext.send({ type: "caption-removed", key: "1" });
    ext.send({
      type: "caption",
      key: "2",
      speaker: "Bruno",
      text: "Open Meetings, o que decidimos?",
    });
    ext.send({ type: "caption-removed", key: "2" });

    const reply = await ext.next((r) => r.type === "reply" && String(r.text).includes("plano B"));
    expect(reply.text).toContain("Decisões");
    ext.send({ type: "stop" });
    await ext.next((r) => r.type === "ended");

    const saved = app.manager.get(id);
    expect(saved).toMatchObject({ status: "ended", platform: "meet", title: "Sem bot" });
    expect(saved?.state.decisions.map((d) => d.text)).toEqual([
      "Então fica decidido que usamos o plano B.",
    ]);
    expect(stt.windows).toEqual([]);
    ext.ws.close();
  });

  it("transcribes tab audio when there are no captions", async () => {
    const stt = fakeStt();
    app = await startTestApp({ stt });
    const ext = connect(app);
    await ext.opened;
    ext.send({ type: "start", title: "Zoom no navegador" });
    const { meetingId } = await ext.next((r) => r.type === "started");
    for (let i = 0; i < 9; i++) ext.ws.send(Buffer.from(tone(1).buffer));
    ext.ws.close();
    await app.manager.getLive(String(meetingId))?.done;
    expect(stt.windows.map((w) => Math.round(w.seconds))).toEqual([8, 1]);
    expect(app.store.listSegments(String(meetingId))[0]?.text).toBe(
      "Trecho 1 transcrito. Trecho 2 transcrito.",
    );
  });

  it("requires the token", async () => {
    app = await startTestApp({
      yaml: `
engines:
  llm:
    fast: { provider: openai-compatible, baseUrl: "http://localhost:1/v1", model: rule }
    smart: { provider: openai-compatible, baseUrl: "http://localhost:1/v1", model: rule }
storage: { driver: sqlite, path: ":memory:" }
server: { authToken: tok-123 }
`,
    });
    await expect(connect(app).opened).rejects.toThrow(/401/);
    await expect(connect(app, "tok-123").opened).resolves.toBeUndefined();
  });
});
