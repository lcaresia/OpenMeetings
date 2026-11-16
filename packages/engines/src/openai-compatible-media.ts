import type { EmbedEngineConfig, SttEngineConfig, TtsEngineConfig } from "@open-meetings/config";
import type { TranscriptSegment } from "@open-meetings/core";
import { type FetchLike, joinUrl, postForm, postJson } from "./http";
import type { EmbedEngine, SttEngine, TtsEngine } from "./types";
import { pcm16ToWav } from "./wav";

type Active<T> = Exclude<T, { provider: "none" }>;

type VerboseTranscription = {
  text?: string;
  language?: string;
  segments?: { start: number; end: number; text: string }[];
};

let sttCounter = 0;

/** `/v1/audio/transcriptions`: whisper.cpp server, Speaches, Groq, OpenAI. */
export function createOpenAiCompatibleStt(
  config: Active<SttEngineConfig>,
  fetchFn: FetchLike,
): SttEngine {
  return {
    model: config.model,
    async transcribe(chunk, opts = {}) {
      const form = new FormData();
      const wav = pcm16ToWav(chunk.pcm, chunk.sampleRate);
      form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
      form.append("model", config.model);
      form.append("response_format", "verbose_json");
      const language = opts.language ?? config.language;
      // Whisper wants ISO-639-1 ("pt"), not a BCP-47 tag ("pt-BR").
      if (language) form.append("language", language.split("-")[0] ?? language);
      if (opts.prompt) form.append("prompt", opts.prompt);

      const res = await postForm(fetchFn, joinUrl(config.baseUrl, "audio/transcriptions"), form, {
        apiKey: config.apiKey,
        signal: opts.signal,
      });
      const body = (await res.json()) as VerboseTranscription;
      const durationMs = (chunk.pcm.length / chunk.sampleRate) * 1000;
      const parts = body.segments?.length
        ? body.segments
        : [{ start: 0, end: durationMs / 1000, text: body.text ?? "" }];

      const segments: TranscriptSegment[] = [];
      for (const part of parts) {
        const text = part.text.trim();
        if (!text) continue;
        segments.push({
          id: `stt-${chunk.startMs}-${sttCounter++}`,
          speaker: opts.speaker ?? "unknown",
          text,
          startMs: Math.round(chunk.startMs + part.start * 1000),
          endMs: Math.round(chunk.startMs + part.end * 1000),
          source: "stt",
          ...(body.language ? { language: body.language } : {}),
        });
      }
      return segments;
    },
  };
}

/** `/v1/audio/speech`: Kokoro or Piper served locally, OpenAI. */
export function createOpenAiCompatibleTts(
  config: Active<TtsEngineConfig>,
  fetchFn: FetchLike,
): TtsEngine {
  return {
    model: config.model,
    async synthesize(text, opts = {}) {
      const res = await postJson(
        fetchFn,
        joinUrl(config.baseUrl, "audio/speech"),
        {
          model: config.model,
          input: text,
          voice: opts.voice ?? config.voice,
          response_format: "mp3",
        },
        { apiKey: config.apiKey, signal: opts.signal },
      );
      if (!res.body) throw new Error("TTS engine returned an empty body");
      return res.body;
    },
  };
}

/** `/v1/embeddings`: Ollama (nomic-embed-text), llama.cpp, OpenAI. */
export function createOpenAiCompatibleEmbed(
  config: Active<EmbedEngineConfig>,
  fetchFn: FetchLike,
): EmbedEngine {
  return {
    model: config.model,
    async embed(texts) {
      if (texts.length === 0) return [];
      const res = await postJson(
        fetchFn,
        joinUrl(config.baseUrl, "embeddings"),
        { model: config.model, input: texts },
        { apiKey: config.apiKey },
      );
      const body = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      return [...body.data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
    },
  };
}
