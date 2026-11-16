import type { LlmEngineConfig } from "@open-meetings/config";
import { type FetchLike, joinUrl, postJson } from "../http";
import { sseData } from "../sse";
import type { ChatDelta, ChatMessage, ChatRequest, FinishReason, LlmEngine } from "../types";

type OpenAiConfig = Extract<LlmEngineConfig, { provider: "openai-compatible" }>;

type StreamChunk = {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
};

function toWireMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "system") return { role: "system", content: message.content };
    if (message.role === "tool") {
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });
}

function mapFinish(reason: string): FinishReason {
  if (reason === "tool_calls" || reason === "function_call") return "tool_calls";
  if (reason === "length") return "length";
  if (reason === "content_filter") return "refusal";
  return "stop";
}

/**
 * Chat Completions adapter. Covers Ollama, llama.cpp, vLLM, LM Studio, Groq, OpenRouter,
 * DeepSeek, Together, OpenAI and Gemini's OpenAI-compatible endpoint.
 */
export function createOpenAiCompatibleLlm(config: OpenAiConfig, fetchFn: FetchLike): LlmEngine {
  // api.openai.com rejects `max_tokens` on its newer models; everyone else only knows `max_tokens`.
  const maxTokensParam = /(^|\.)openai\.com$/.test(new URL(config.baseUrl).hostname)
    ? "max_completion_tokens"
    : "max_tokens";

  return {
    provider: "openai-compatible",
    model: config.model,
    nativeTools: config.toolCalling === "native",

    async *chat(req: ChatRequest): AsyncGenerator<ChatDelta> {
      const maxTokens = req.maxTokens ?? config.maxTokens;
      const body: Record<string, unknown> = {
        model: config.model,
        messages: toWireMessages(req.messages),
        stream: true,
        stream_options: { include_usage: true },
      };
      if (req.temperature !== undefined) body.temperature = req.temperature;
      if (maxTokens !== undefined) body[maxTokensParam] = maxTokens;
      if (req.json) body.response_format = { type: "json_object" };
      if (req.tools?.length) {
        body.tools = req.tools.map((tool) => ({
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        }));
      }

      const res = await postJson(fetchFn, joinUrl(config.baseUrl, "chat/completions"), body, {
        apiKey: config.apiKey,
        signal: req.signal,
      });

      const calls = new Map<number, { id: string; name: string; args: string }>();
      let finish: FinishReason = "stop";
      let usage: StreamChunk["usage"];

      for await (const data of sseData(res)) {
        if (data === "[DONE]") break;
        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(data) as StreamChunk;
        } catch {
          continue; // keep-alive comments and partial junk from some servers
        }
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) yield { type: "text", text: choice.delta.content };
        for (const part of choice.delta?.tool_calls ?? []) {
          const index = part.index ?? 0;
          const call = calls.get(index) ?? { id: "", name: "", args: "" };
          if (part.id) call.id = part.id;
          if (part.function?.name) call.name += part.function.name;
          if (part.function?.arguments) call.args += part.function.arguments;
          calls.set(index, call);
        }
        if (choice.finish_reason) finish = mapFinish(choice.finish_reason);
      }

      const sorted = [...calls.entries()].sort(([a], [b]) => a - b);
      for (const [index, call] of sorted) {
        yield {
          type: "tool_call",
          call: { id: call.id || `call_${index}`, name: call.name, arguments: call.args || "{}" },
        };
      }
      if (sorted.length) finish = "tool_calls";
      if (usage) {
        yield {
          type: "usage",
          usage: {
            inputTokens: usage.prompt_tokens ?? 0,
            outputTokens: usage.completion_tokens ?? 0,
            cachedInputTokens: usage.prompt_tokens_details?.cached_tokens,
          },
        };
      }
      yield { type: "done", finishReason: finish };
    },
  };
}
