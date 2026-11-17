import { parseConfig } from "@open-meetings/config";
import type { EmbedEngine, Engines, LlmEngine } from "@open-meetings/core";
import { createRuleLlm } from "@open-meetings/core/testing";
import type { FetchLike } from "@open-meetings/engines";
import type { Tool } from "@open-meetings/tools";
import { type App, startApp } from "./app";

/** Bag-of-words vectors: similar wording gives similar vectors, deterministically. */
export function fakeEmbed(dimensions = 64): EmbedEngine {
  return {
    model: "fake-embed",
    async embed(texts) {
      return texts.map((text) => {
        const vector = new Array<number>(dimensions).fill(0);
        for (const word of text
          .toLowerCase()
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .match(/[a-z0-9]{3,}/g) ?? []) {
          let hash = 0;
          for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
          vector[hash % dimensions] = (vector[hash % dimensions] ?? 0) + 1;
        }
        return vector;
      });
    },
  };
}

export type TestAppOptions = {
  yaml?: string;
  smart?: LlmEngine;
  tools?: Tool[];
  fetch?: FetchLike;
  embed?: boolean;
};

/** A real server on a free port, with deterministic models and an in-memory database. */
export async function startTestApp(
  options: TestAppOptions = {},
): Promise<App & { engines: Engines }> {
  const yaml =
    options.yaml ??
    `
profile: test
engines:
  llm:
    fast: { provider: openai-compatible, baseUrl: "http://localhost:1/v1", model: rule }
    smart: { provider: openai-compatible, baseUrl: "http://localhost:1/v1", model: rule }
storage: { driver: sqlite, path: ":memory:" }
agent: { language: pt-BR, summaryIntervalSec: 45 }
`;
  const loaded = parseConfig(yaml, {});
  const fast = createRuleLlm();
  const engines: Engines = {
    llm: { fast, smart: options.smart ?? fast },
    ...(options.embed === false ? {} : { embed: fakeEmbed() }),
  };
  const app = await startApp(loaded, {
    engines,
    port: 0,
    noBot: true,
    ...(options.tools ? { extraTools: options.tools } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    logger: (await import("@open-meetings/core")).createLogger("test", "silent"),
  });
  return { ...app, engines };
}

export type SseEvent = { type: string } & Record<string, unknown>;

/** POSTs a RunAgentInput and yields the AG-UI events as they arrive. */
export async function* aguiRun(
  url: string,
  input: Record<string, unknown>,
  headers: Record<string, string> = {},
): AsyncGenerator<SseEvent> {
  const res = await fetch(`${url}/agui`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", ...headers },
    body: JSON.stringify({
      runId: crypto.randomUUID(),
      messages: [],
      tools: [],
      context: [],
      ...input,
    }),
  });
  if (!res.ok || !res.body) throw new Error(`AG-UI answered ${res.status}: ${await res.text()}`);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) yield JSON.parse(line.slice(5).trim()) as SseEvent;
      }
      end = buffer.indexOf("\n\n");
    }
  }
}

/** Collects events until `until` returns true (or the stream ends). */
export async function collect(
  stream: AsyncGenerator<SseEvent>,
  until: (event: SseEvent, all: SseEvent[]) => boolean = () => false,
): Promise<SseEvent[]> {
  const all: SseEvent[] = [];
  for await (const event of stream) {
    all.push(event);
    if (until(event, all)) break;
  }
  return all;
}
