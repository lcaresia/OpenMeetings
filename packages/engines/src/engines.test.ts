import { parseConfig } from "@open-meetings/config";
import { describe, expect, it } from "vitest";
import {
  collectChat,
  createAnthropicLlm,
  createEngines,
  createOpenAiCompatibleLlm,
  createOpenAiCompatibleStt,
  estimateHourlyCost,
  NetworkBlockedError,
  pcm16ToWav,
  sseData,
  toAnthropicMessages,
} from "./index";
import { anthropicStream, fakeFetch, openAiTextStream, sseResponse } from "./testing";

const openAiConfig = {
  provider: "openai-compatible" as const,
  baseUrl: "http://localhost:11434/v1/",
  model: "qwen",
  apiKey: "secret",
  toolCalling: "native" as const,
};

const TOOL = {
  name: "create_doc",
  description: "Creates a document",
  parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
};

describe("sseData", () => {
  it("handles payloads split across chunks and CRLF line endings", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of ['data: {"a"', ":1}\r\n\r\nda", "ta: [DONE]"]) {
          controller.enqueue(encoder.encode(part));
        }
        controller.close();
      },
    });
    const out: string[] = [];
    for await (const data of sseData(new Response(body))) out.push(data);
    expect(out).toEqual(['{"a":1}', "[DONE]"]);
  });
});

describe("OpenAI-compatible LLM", () => {
  it("streams text and reports usage", async () => {
    const { fetchFn, requests } = fakeFetch(() => openAiTextStream("Olá"));
    const engine = createOpenAiCompatibleLlm(openAiConfig, fetchFn);
    const result = await collectChat(
      engine.chat({ messages: [{ role: "user", content: "oi" }], json: true, maxTokens: 50 }),
    );

    expect(result).toMatchObject({ text: "Olá", finishReason: "stop" });
    expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 3 });
    expect(requests[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer secret");
    expect(requests[0]?.body).toMatchObject({
      model: "qwen",
      stream: true,
      max_tokens: 50,
      response_format: { type: "json_object" },
    });
  });

  it("assembles tool calls streamed in fragments", async () => {
    const chunk = (delta: unknown, finish?: string) =>
      JSON.stringify({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] });
    const { fetchFn, requests } = fakeFetch(() =>
      sseResponse([
        chunk({
          tool_calls: [
            { index: 0, id: "call_a", function: { name: "create_doc", arguments: '{"ti' } },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: 'tle":"Ata"}' } }] }),
        chunk({ tool_calls: [{ index: 1, function: { name: "create_doc", arguments: "{}" } }] }),
        chunk({}, "tool_calls"),
        "[DONE]",
      ]),
    );
    const engine = createOpenAiCompatibleLlm(openAiConfig, fetchFn);
    const result = await collectChat(
      engine.chat({ messages: [{ role: "user", content: "crie" }], tools: [TOOL] }),
    );

    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      { id: "call_a", name: "create_doc", arguments: '{"title":"Ata"}' },
      { id: "call_1", name: "create_doc", arguments: "{}" },
    ]);
    expect(requests[0]?.body).toMatchObject({
      tools: [{ type: "function", function: { name: "create_doc" } }],
    });
  });

  it("surfaces HTTP errors with the status", async () => {
    const { fetchFn } = fakeFetch(() => new Response("model not found", { status: 404 }));
    const engine = createOpenAiCompatibleLlm(openAiConfig, fetchFn);
    await expect(
      collectChat(engine.chat({ messages: [{ role: "user", content: "x" }] })),
    ).rejects.toThrow(/HTTP 404.*model not found/);
  });
});

describe("Anthropic LLM", () => {
  const config = {
    provider: "anthropic" as const,
    model: "claude-haiku-5-5",
    apiKey: "sk-ant-x",
    maxTokens: 1000,
  };

  it("streams text, returns tool calls, counts cached tokens, marks cache breakpoints", async () => {
    const { fetchFn, requests } = fakeFetch(() =>
      anthropicStream({
        text: "Criando.",
        tool: { id: "toolu_1", name: "create_doc", input: { title: "Ata" } },
        usage: { cache_read_input_tokens: 90, cache_creation_input_tokens: 5 },
      }),
    );
    const engine = createAnthropicLlm(config, fetchFn);
    const result = await collectChat(
      engine.chat({
        messages: [
          { role: "system", content: "Você é o agente.", cache: true },
          { role: "user", content: "crie a ata" },
        ],
        tools: [TOOL],
        temperature: 0.2,
      }),
    );

    expect(result.text).toBe("Criando.");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      { id: "toolu_1", name: "create_doc", arguments: '{"title":"Ata"}' },
    ]);
    expect(result.usage).toEqual({ inputTokens: 105, outputTokens: 20, cachedInputTokens: 90 });

    const sent = requests[0];
    expect(sent?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent?.headers.get("authorization")).toBe("Bearer sk-ant-x");
    expect(sent?.body).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: 1000,
      stream: true,
      system: [{ type: "text", text: "Você é o agente.", cache_control: { type: "ephemeral" } }],
      tools: [{ name: "create_doc", input_schema: TOOL.parameters }],
    });
    expect(sent?.body).not.toHaveProperty("temperature");
  });

  it("does not hand over tool calls from a turn cut by max_tokens", async () => {
    const { fetchFn } = fakeFetch(() =>
      anthropicStream({
        tool: { id: "t", name: "create_doc", input: {} },
        stopReason: "max_tokens",
      }),
    );
    const result = await collectChat(
      createAnthropicLlm(config, fetchFn).chat({
        messages: [{ role: "user", content: "x" }],
        tools: [TOOL],
      }),
    );
    expect(result).toMatchObject({ finishReason: "length", toolCalls: [] });
  });

  it("groups consecutive tool results into one user turn", () => {
    const messages = toAnthropicMessages([
      { role: "user", content: "faça" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "a", name: "x", arguments: "{}" },
          { id: "b", name: "y", arguments: '{"n":1}' },
        ],
      },
      { role: "tool", toolCallId: "a", content: "ok" },
      { role: "tool", toolCallId: "b", content: "falhou", isError: true },
    ]);
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "ok" },
        { type: "tool_result", tool_use_id: "b", content: "falhou", is_error: true },
      ],
    });
  });
});

describe("STT", () => {
  it("posts a WAV file and offsets segment times by the chunk start", async () => {
    const { fetchFn, requests } = fakeFetch(() =>
      Response.json({ language: "pt", segments: [{ start: 0.5, end: 1.5, text: " bom dia " }] }),
    );
    const stt = createOpenAiCompatibleStt(
      {
        provider: "openai-compatible",
        baseUrl: "http://localhost:8000/v1",
        model: "whisper",
        language: "pt-BR",
      },
      fetchFn,
    );
    const segments = await stt.transcribe(
      { pcm: new Int16Array(32000), sampleRate: 16000, startMs: 10_000 },
      { speaker: "Ana" },
    );

    expect(segments).toMatchObject([
      {
        speaker: "Ana",
        text: "bom dia",
        startMs: 10_500,
        endMs: 11_500,
        source: "stt",
        language: "pt",
      },
    ]);
    const form = requests[0]?.body as FormData;
    expect(form.get("model")).toBe("whisper");
    expect(form.get("language")).toBe("pt");
    expect((form.get("file") as File).size).toBe(44 + 64000);
  });

  it("writes a valid WAV header", () => {
    const wav = pcm16ToWav(new Int16Array([1, -1]), 16000);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(16000);
    expect(wav.length).toBe(48);
  });
});

describe("local-only guarantee", () => {
  const yaml = (profile: string, smartUrl: string) => `
profile: ${profile}
engines:
  llm:
    fast:  { provider: openai-compatible, baseUrl: http://localhost:11434/v1, model: a }
    smart: { provider: openai-compatible, baseUrl: ${smartUrl}, model: b }
`;

  it("blocks a remote engine before any connection is attempted", async () => {
    const { fetchFn, requests } = fakeFetch(() => openAiTextStream("ok"));
    const { config } = parseConfig(yaml("local", "https://api.groq.com/openai/v1"), {});
    const engines = createEngines(config, { fetch: fetchFn });

    await expect(
      collectChat(engines.llm.smart.chat({ messages: [{ role: "user", content: "x" }] })),
    ).rejects.toBeInstanceOf(NetworkBlockedError);
    await collectChat(engines.llm.fast.chat({ messages: [{ role: "user", content: "x" }] }));
    expect(requests.map((request) => new URL(request.url).hostname)).toEqual(["localhost"]);
  });

  it("allows the same engine outside the local profile", async () => {
    const { fetchFn, requests } = fakeFetch(() => openAiTextStream("ok"));
    const { config } = parseConfig(yaml("custom", "https://api.groq.com/openai/v1"), {});
    await collectChat(
      createEngines(config, { fetch: fetchFn }).llm.smart.chat({
        messages: [{ role: "user", content: "x" }],
      }),
    );
    expect(requests).toHaveLength(1);
  });
});

describe("estimateHourlyCost", () => {
  const base = `
engines:
  llm:
    fast:  { provider: openai-compatible, baseUrl: https://api.groq.com/openai/v1, model: llama-3.1-8b-instant }
    smart: { provider: anthropic, model: claude-haiku-5-5, apiKey: k }
`;

  it("is zero for models served locally", () => {
    const { config } = parseConfig(
      base
        .replace("https://api.groq.com/openai/v1", "http://ollama:11434/v1")
        .replace(
          "{ provider: anthropic, model: claude-haiku-5-5, apiKey: k }",
          "{ provider: openai-compatible, baseUrl: http://ollama:11434/v1, model: big }",
        ),
      {},
    );
    expect(estimateHourlyCost(config)).toMatchObject({ totalUsd: 0, unpricedModels: [] });
  });

  it("refuses to guess the price of an unlisted remote model", () => {
    const { config } = parseConfig(base, {});
    expect(estimateHourlyCost(config)).toMatchObject({
      totalUsd: undefined,
      unpricedModels: ["llama-3.1-8b-instant", "claude-haiku-5-5"],
    });
  });

  it("uses the configured prices", () => {
    const { config } = parseConfig(
      `${base}pricing:\n  llama-3.1-8b-instant: { in: 0.05, out: 0.08 }\n  claude-haiku-5-5: { in: 0.10, out: 0.50 }\n`,
      {},
    );
    const cost = estimateHourlyCost(config);
    // 80 fast calls: 176k in, 20k out. Smart: 46k in, 6.2k out.
    expect(cost.fastUsd).toBeCloseTo(0.0104, 6);
    expect(cost.smartUsd).toBeCloseTo(0.0077, 6);
    expect(cost.totalUsd).toBeLessThan(0.05);
  });
});
