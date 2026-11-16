import Anthropic from "@anthropic-ai/sdk";
import type { LlmEngineConfig } from "@open-meetings/config";
import type { FetchLike } from "../http";
import type { ChatDelta, ChatMessage, ChatRequest, FinishReason, LlmEngine } from "../types";

type AnthropicConfig = Extract<LlmEngineConfig, { provider: "anthropic" }>;

const JSON_ONLY = "Respond with a single JSON object and nothing else: no prose, no code fences.";

function parseArgs(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json || "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Tool results must travel together in one user turn, right after the assistant turn. */
export function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
    } else if (message.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: parseArgs(call.arguments),
        });
      }
      if (content.length) out.push({ role: "assistant", content });
    } else {
      const result: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
        ...(message.isError ? { is_error: true } : {}),
      };
      const last = out.at(-1);
      const lastIsToolResults =
        last?.role === "user" &&
        Array.isArray(last.content) &&
        last.content.every((block) => block.type === "tool_result");
      if (lastIsToolResults && Array.isArray(last.content)) last.content.push(result);
      else out.push({ role: "user", content: [result] });
    }
  }
  return out;
}

function mapStop(reason: string | null): FinishReason {
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  if (reason === "refusal") return "refusal";
  return "stop";
}

/**
 * Native Messages API adapter (official SDK), kept separate from the OpenAI-compatible one
 * for prompt caching and tool use. Sampling parameters are never sent: current Claude models
 * reject them.
 */
export function createAnthropicLlm(config: AnthropicConfig, fetchFn: FetchLike): LlmEngine {
  const client = new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    fetch: fetchFn as typeof fetch,
  });

  return {
    provider: "anthropic",
    model: config.model,
    nativeTools: true,

    async *chat(req: ChatRequest): AsyncGenerator<ChatDelta> {
      const system: Anthropic.TextBlockParam[] = [];
      for (const message of req.messages) {
        if (message.role !== "system") continue;
        system.push({
          type: "text",
          text: message.content,
          ...(message.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
        });
      }
      if (req.json) system.push({ type: "text", text: JSON_ONLY });

      const stream = client.messages.stream(
        {
          model: config.model,
          max_tokens: req.maxTokens ?? config.maxTokens,
          ...(system.length ? { system } : {}),
          messages: toAnthropicMessages(req.messages),
          ...(req.tools?.length
            ? {
                tools: req.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  input_schema: tool.parameters as Anthropic.Tool.InputSchema,
                })),
              }
            : {}),
        },
        { signal: req.signal },
      );

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "text", text: event.delta.text };
        }
      }

      const final = await stream.finalMessage();
      const finish = mapStop(final.stop_reason);
      // A turn cut by max_tokens or a refusal can carry a truncated tool input: never run it.
      if (finish === "tool_calls") {
        for (const block of final.content) {
          if (block.type !== "tool_use") continue;
          yield {
            type: "tool_call",
            call: { id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          };
        }
      }
      const cached = final.usage.cache_read_input_tokens ?? 0;
      yield {
        type: "usage",
        usage: {
          inputTokens:
            final.usage.input_tokens + cached + (final.usage.cache_creation_input_tokens ?? 0),
          outputTokens: final.usage.output_tokens,
          cachedInputTokens: cached,
        },
      };
      yield { type: "done", finishReason: finish };
    },
  };
}
