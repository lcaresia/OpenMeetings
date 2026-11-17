import { parseConfig } from "@open-meetings/config";
import { createLogger } from "@open-meetings/core";
import { createLiveSource } from "@open-meetings/core/testing";
import { createEngines, type FetchLike, NetworkBlockedError } from "@open-meetings/engines";
import { openAiTextStream } from "@open-meetings/engines/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type App, startApp } from "./app";

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * The local profile's promise: nothing leaves the machine. A whole meeting runs with real engine
 * adapters (pointed at local endpoints, answered by a fake) and a webhook pointed at the
 * internet. Every request is recorded; the test fails if any of them targets a public host.
 */
describe("profile local", () => {
  it("makes no request outside the machine during a whole meeting", async () => {
    const requested: string[] = [];
    const answer: FetchLike = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      requested.push(url);
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as { messages?: { content: string }[] })
          : {};
      if (url.endsWith("/embeddings")) {
        const inputs = (body as { input?: string[] }).input ?? [];
        return Response.json({ data: inputs.map((_, index) => ({ index, embedding: [1, 0, 0] })) });
      }
      const system = body.messages?.[0]?.content ?? "";
      // Notes updater, intent router and minutes writer, answered in their expected formats.
      if (system.includes("JSON Patch"))
        return openAiTextStream(
          '{"patch":[{"op":"add","path":"/decisions/-","value":{"text":"Usar Postgres"}}]}',
        );
      if (system.includes("route requests"))
        return openAiTextStream('{"intent":"decisions","request":"o que decidimos?"}');
      return openAiTextStream("Resumo da reunião.");
    };

    app = await startApp(
      parseConfig(`
profile: local
engines:
  llm:
    fast: { provider: openai-compatible, baseUrl: "http://localhost:11434/v1", model: qwen }
    smart: { provider: openai-compatible, baseUrl: "http://ollama:11434/v1", model: qwen-big }
  embed: { provider: openai-compatible, baseUrl: "http://127.0.0.1:11434/v1", model: nomic }
storage: { driver: sqlite, path: ":memory:" }
outputs: { postSummaryTo: [chat, webhook], webhookUrl: "https://hooks.example.com/leak" }
`),
      { fetch: answer, port: 0, noBot: true, logger: createLogger("test", "silent") },
    );

    const source = createLiveSource();
    const live = app.manager.start({ source, title: "Local" });
    source.join("ana", "Ana");
    source.say("Ana", "Então fica decidido que vamos usar Postgres.");
    source.chat("Ana", "om o que decidimos?");
    await source.waitForChat("Postgres");
    source.end();
    await live.done;

    const hosts = [...new Set(requested.map((url) => new URL(url).hostname))].sort();
    expect(hosts).toEqual(["127.0.0.1", "localhost", "ollama"]);
    expect(requested.some((url) => url.includes("example.com"))).toBe(false);
    expect(app.manager.get(live.record.id)?.minutes).toContain("Resumo da reunião.");
  });

  it("refuses a public engine address before connecting", async () => {
    const requested: string[] = [];
    const config = parseConfig(`
profile: local
engines:
  llm:
    fast: { provider: openai-compatible, baseUrl: "https://api.groq.com/openai/v1", model: x }
    smart: { provider: openai-compatible, baseUrl: "http://localhost:11434/v1", model: y }
`).config;
    const engines = createEngines(config, {
      fetch: async (input) => {
        requested.push(String(input));
        return new Response("{}");
      },
    });
    const run = async () => {
      for await (const _ of engines.llm.fast.chat({ messages: [{ role: "user", content: "x" }] })) {
        // drain
      }
    };
    await expect(run()).rejects.toBeInstanceOf(NetworkBlockedError);
    expect(requested).toEqual([]);
  });
});
