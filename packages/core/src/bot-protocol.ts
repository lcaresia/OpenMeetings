import type { CaptureEvent, MeetingRef } from "./types";

/**
 * Wire protocol between the server and a bot worker, over one local WebSocket.
 *
 * The bot is a separate process on purpose: a browser automating a meeting is the least
 * reliable part of the system and must be able to crash without taking the server down.
 * A worker connects, says hello, and then runs one browser per meeting it is asked to join.
 */

export type BotJoinOptions = {
  displayName: string;
  /** Playwright storageState file of a dedicated account. Joins as a guest when absent. */
  storageState?: string;
  headless: boolean;
  captionsLanguage?: string;
  captureAudio: boolean;
  admissionTimeoutSec: number;
};

/** Server -> bot. */
export type BotCommand =
  | { type: "join"; sessionId: string; meeting: MeetingRef; options: BotJoinOptions }
  | { type: "chat"; sessionId: string; requestId: string; text: string }
  | { type: "stop"; sessionId: string };

/** A capture event with audio as base64, so it survives JSON. */
export type WireCaptureEvent =
  | Exclude<CaptureEvent, { type: "audio" }>
  | { type: "audio"; chunk: { pcmBase64: string; sampleRate: number; startMs: number } };

/** Bot -> server. */
export type BotMessage =
  | { type: "hello"; workerId: string; platforms: string[] }
  | { type: "event"; sessionId: string; event: WireCaptureEvent }
  | { type: "ack"; sessionId: string; requestId: string; error?: string }
  /** The session is over on the bot side: browser closed, crashed, or never got in. */
  | { type: "closed"; sessionId: string; reason: string; error?: boolean };

export function toWireEvent(event: CaptureEvent): WireCaptureEvent {
  if (event.type !== "audio") return event;
  const { pcm, sampleRate, startMs } = event.chunk;
  const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return { type: "audio", chunk: { pcmBase64: bytes.toString("base64"), sampleRate, startMs } };
}

export function fromWireEvent(event: WireCaptureEvent): CaptureEvent {
  if (event.type !== "audio") return event;
  const bytes = Buffer.from(event.chunk.pcmBase64, "base64");
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  return {
    type: "audio",
    chunk: { pcm, sampleRate: event.chunk.sampleRate, startMs: event.chunk.startMs },
  };
}
