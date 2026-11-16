/** A stretch of speech attributed to one speaker. */
export type TranscriptSegment = {
  id: string;
  speaker: string;
  text: string;
  /** Milliseconds since the start of the meeting. */
  startMs: number;
  endMs: number;
  /** True while the platform is still rewriting this segment. */
  partial?: boolean;
  source: "captions" | "stt" | "fixture";
  language?: string;
};

/** Mono PCM 16-bit audio. */
export type AudioChunk = {
  pcm: Int16Array;
  sampleRate: number;
  startMs: number;
};

export type Participant = {
  id: string;
  name: string;
  email?: string;
  /** True when the participant is outside `consent.internalDomains`. */
  external?: boolean;
};

/** A message typed in the call's chat (not an LLM message). */
export type CallChatMessage = {
  id: string;
  sender: string;
  text: string;
  atMs: number;
};

export type CaptureEvent =
  | { type: "transcript"; segment: TranscriptSegment }
  | { type: "audio"; chunk: AudioChunk }
  | { type: "participant"; action: "joined" | "left"; participant: Participant; atMs: number }
  | { type: "chat"; message: CallChatMessage }
  | { type: "ended"; reason: string };

export type MeetingRef = {
  id: string;
  platform: string;
  url?: string;
  title?: string;
};

/** Anything that can feed a meeting into the pipeline: a bot, an extension, a file. */
export interface CaptureSource {
  id: string;
  start(meeting: MeetingRef): AsyncIterable<CaptureEvent>;
  sendChat?(text: string): Promise<void>;
  speak?(audio: ReadableStream<Uint8Array>): Promise<void>;
  stop(): Promise<void>;
}
