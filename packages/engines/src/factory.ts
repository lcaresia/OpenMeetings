import { type Config, isLocalOnly, type LlmEngineConfig } from "@open-meetings/config";
import { type FetchLike, guardedFetch } from "./http";
import { withJsonToolFallback } from "./json-tools";
import { createAnthropicLlm } from "./llm/anthropic";
import { createOpenAiCompatibleLlm } from "./llm/openai-compatible";
import {
  createOpenAiCompatibleEmbed,
  createOpenAiCompatibleStt,
  createOpenAiCompatibleTts,
} from "./openai-compatible-media";
import type { Engines, LlmEngine } from "./types";

export function createLlm(config: LlmEngineConfig, fetchFn: FetchLike): LlmEngine {
  if (config.provider === "anthropic") return createAnthropicLlm(config, fetchFn);
  const engine = createOpenAiCompatibleLlm(config, fetchFn);
  // Models without native tool calling get tools through validated JSON answers.
  return engine.nativeTools ? engine : withJsonToolFallback(engine);
}

/** The fetch every engine must use: enforces the local-only guarantee in one place. */
export function engineFetch(config: Config, base: FetchLike = fetch): FetchLike {
  return guardedFetch(base, { localOnly: isLocalOnly(config) });
}

/** Builds every engine named in the config. This is the only place a provider is chosen. */
export function createEngines(config: Config, options: { fetch?: FetchLike } = {}): Engines {
  const fetchFn = engineFetch(config, options.fetch);
  const { llm, stt, tts, embed } = config.engines;
  return {
    llm: { fast: createLlm(llm.fast, fetchFn), smart: createLlm(llm.smart, fetchFn) },
    ...(stt.provider === "none" ? {} : { stt: createOpenAiCompatibleStt(stt, fetchFn) }),
    ...(tts.provider === "none" ? {} : { tts: createOpenAiCompatibleTts(tts, fetchFn) }),
    ...(embed.provider === "none" ? {} : { embed: createOpenAiCompatibleEmbed(embed, fetchFn) }),
  };
}
