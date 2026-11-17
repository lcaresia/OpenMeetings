import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { AsyncQueue, type CaptureEvent, type CaptureSource } from "@open-meetings/core";

const RATE = 16000;

/** Reads a PCM16 WAV file without ffmpeg: mono or stereo (mixed down), any sample rate. */
export function readWav(buffer: Buffer): { pcm: Int16Array; sampleRate: number } {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV file");
  }
  let offset = 12;
  let channels = 1;
  let sampleRate = RATE;
  let bits = 16;
  let format = 1;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = buffer.readUInt16LE(body);
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bits = buffer.readUInt16LE(body + 14);
    } else if (id === "data") {
      if (format !== 1 || bits !== 16)
        throw new Error("only 16-bit PCM WAV can be read without ffmpeg");
      const frames = Math.floor(Math.min(size, buffer.length - body) / (2 * channels));
      const pcm = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += buffer.readInt16LE(body + (i * channels + c) * 2);
        pcm[i] = Math.round(sum / channels);
      }
      return { pcm, sampleRate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV file has no data");
}

/**
 * A recorded meeting (any audio or video file ffmpeg can read) played into the pipeline as
 * one-second PCM chunks, as fast as the transcription engine takes them.
 */
export function createFileSource(
  path: string,
  options: { ffmpeg?: string; isWav?: boolean } = {},
): CaptureSource {
  let stopped = false;
  let kill: (() => void) | undefined;

  return {
    id: "file",
    async *start(): AsyncGenerator<CaptureEvent> {
      const chunks = new AsyncQueue<Int16Array>();
      let failure: Error | undefined;
      let sampleRate = RATE;

      // WAV files still work on a machine without ffmpeg.
      const ffmpegMissing = Boolean(spawnSync(options.ffmpeg ?? "ffmpeg", ["-version"]).error);
      if (options.isWav && ffmpegMissing) {
        const wav = readWav(readFileSync(path));
        sampleRate = wav.sampleRate;
        for (let i = 0; i < wav.pcm.length; i += sampleRate)
          chunks.push(wav.pcm.subarray(i, i + sampleRate));
        chunks.close();
      } else {
        const ffmpeg = spawn(
          options.ffmpeg ?? "ffmpeg",
          [
            "-nostdin",
            "-loglevel",
            "error",
            "-i",
            path,
            "-vn",
            "-f",
            "s16le",
            "-ac",
            "1",
            "-ar",
            String(RATE),
            "pipe:1",
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        kill = () => ffmpeg.kill("SIGKILL");
        let pending = Buffer.alloc(0);
        let errors = "";
        const second = RATE * 2;
        ffmpeg.stdout.on("data", (data: Buffer) => {
          pending = Buffer.concat([pending, data]);
          while (pending.length >= second) {
            const piece = Buffer.from(pending.subarray(0, second));
            pending = pending.subarray(second);
            chunks.push(new Int16Array(piece.buffer, piece.byteOffset, piece.length / 2));
          }
        });
        ffmpeg.stderr.on("data", (data: Buffer) => {
          errors += data.toString();
        });
        ffmpeg.on("error", (error: NodeJS.ErrnoException) => {
          failure =
            error.code === "ENOENT"
              ? new Error("ffmpeg is needed to read this file (only 16-bit WAV works without it)")
              : error;
          chunks.close();
        });
        ffmpeg.on("close", (code) => {
          if (pending.length >= 2) {
            const piece = Buffer.from(pending.subarray(0, pending.length - (pending.length % 2)));
            chunks.push(new Int16Array(piece.buffer, piece.byteOffset, piece.length / 2));
          }
          if (code && !stopped)
            failure ??= new Error(`ffmpeg could not read the file: ${errors.trim().slice(0, 300)}`);
          chunks.close();
        });
      }

      let startMs = 0;
      for await (const pcm of chunks) {
        if (stopped) break;
        yield { type: "audio", chunk: { pcm, sampleRate, startMs } };
        startMs += Math.round((pcm.length / sampleRate) * 1000);
      }
      if (failure) throw failure;
      yield { type: "ended", reason: "file processed" };
    },
    async stop() {
      stopped = true;
      kill?.();
    },
  };
}
