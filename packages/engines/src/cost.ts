import { type Config, isLocalUrl, type LlmEngineConfig } from "@open-meetings/config";
import type { Usage } from "./types";

export type Price = { in: number; out: number };

/** USD for one call. Prices are per 1M tokens. */
export function usageCost(usage: Usage, price: Price | undefined): number {
  if (!price) return 0;
  return (usage.inputTokens * price.in + usage.outputTokens * price.out) / 1_000_000;
}

/**
 * Price of a configured model. Models served from a private address cost nothing; a remote
 * model with no entry in `pricing` is unknown (`undefined`), never silently free.
 */
export function priceFor(engine: LlmEngineConfig, pricing: Config["pricing"]): Price | undefined {
  const listed = pricing[engine.model];
  if (listed) return listed;
  if (engine.provider === "openai-compatible" && isLocalUrl(engine.baseUrl))
    return { in: 0, out: 0 };
  return undefined;
}

/**
 * Workload behind the per-hour estimate. A deliberately simple model of a talkative meeting:
 * the fast model runs once per summary interval on state + delta; the smart model answers a
 * handful of commands and writes the final minutes.
 */
export const HOURLY_WORKLOAD = {
  fastInputTokens: 2200,
  fastOutputTokens: 250,
  smartCommands: 6,
  smartInputTokens: 5000,
  smartOutputTokens: 700,
  minutesInputTokens: 16000,
  minutesOutputTokens: 2000,
};

export type HourlyCost = {
  fastUsd: number | undefined;
  smartUsd: number | undefined;
  /** Undefined when any model has no known price. */
  totalUsd: number | undefined;
  unpricedModels: string[];
};

export function estimateHourlyCost(config: Config): HourlyCost {
  const w = HOURLY_WORKLOAD;
  const fastCalls = 3600 / config.agent.summaryIntervalSec;
  const { fast, smart } = config.engines.llm;
  const fastPrice = priceFor(fast, config.pricing);
  const smartPrice = priceFor(smart, config.pricing);

  const fastUsd = fastPrice
    ? usageCost(
        {
          inputTokens: fastCalls * w.fastInputTokens,
          outputTokens: fastCalls * w.fastOutputTokens,
        },
        fastPrice,
      )
    : undefined;
  const smartUsd = smartPrice
    ? usageCost(
        {
          inputTokens: w.smartCommands * w.smartInputTokens + w.minutesInputTokens,
          outputTokens: w.smartCommands * w.smartOutputTokens + w.minutesOutputTokens,
        },
        smartPrice,
      )
    : undefined;

  const unpricedModels = [...(fastPrice ? [] : [fast.model]), ...(smartPrice ? [] : [smart.model])];
  return {
    fastUsd,
    smartUsd,
    totalUsd: fastUsd !== undefined && smartUsd !== undefined ? fastUsd + smartUsd : undefined,
    unpricedModels: [...new Set(unpricedModels)],
  };
}
