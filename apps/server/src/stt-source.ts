import type {
  AudioChunk,
  CaptureEvent,
  CaptureSource,
  MeetingRef,
  SttEngine,
} from "@open-meetings/core";

export type SttSourceOptions = {
  language?: string;
  /** Seconds of audio sent per transcription request. */
  windowSec?: number;
  onError?: (error: Error) => void;
};

/**
 * Turns the audio a source produces into transcript segments with an STT engine. Captions,
 * when the source has them, pass through untouched; without an STT engine audio is dropped.
 *
 * Audio is buffered into windows of a few seconds: shorter windows lower latency, longer ones
 * give Whisper-class models enough context to transcribe well.
 */
export function withStt(
  source: CaptureSource,
  stt: SttEngine | undefined,
  options: SttSourceOptions = {},
): CaptureSource {
  if (!stt) return source;
  const windowSec = options.windowSec ?? 8;

  return {
    ...source,
    id: `${source.id}+stt`,
    async *start(meeting: MeetingRef): AsyncGenerator<CaptureEvent> {
      let parts: Int16Array[] = [];
      let samples = 0;
      let startMs = 0;
      let sampleRate = 16000;
      let previousText = "";

      const drain = async (): Promise<CaptureEvent[]> => {
        if (samples === 0) return [];
        const pcm = new Int16Array(samples);
        let offset = 0;
        for (const part of parts) {
          pcm.set(part, offset);
          offset += part.length;
        }
        const chunk: AudioChunk = { pcm, sampleRate, startMs };
        parts = [];
        samples = 0;
        try {
          const segments = await stt.transcribe(chunk, {
            ...(options.language ? { language: options.language } : {}),
            // The previous window helps the model keep names and context consistent.
            ...(previousText ? { prompt: previousText.slice(-200) } : {}),
          });
          previousText = segments.map((segment) => segment.text).join(" ") || previousText;
          return segments.map((segment) => ({ type: "transcript", segment }));
        } catch (error) {
          options.onError?.(error as Error);
          return [];
        }
      };

      for await (const event of source.start(meeting)) {
        if (event.type !== "audio") {
          if (event.type === "ended") for (const out of await drain()) yield out;
          yield event;
          continue;
        }
        if (samples === 0) {
          startMs = event.chunk.startMs;
          sampleRate = event.chunk.sampleRate;
        }
        parts.push(event.chunk.pcm);
        samples += event.chunk.pcm.length;
        if (samples >= sampleRate * windowSec) for (const out of await drain()) yield out;
      }
      for (const out of await drain()) yield out;
    },
  };
}
