import {
  type ChatDelta,
  type ChatMessage,
  type ChatRequest,
  collectChat,
  extractJson,
  type LlmEngine,
  type ToolDef,
  type Usage,
} from "@open-meetings/core";
import { z } from "zod";

const answerSchema = z.union([
  z.object({
    tool_calls: z
      .array(
        z.object({
          name: z.string().min(1),
          arguments: z.record(z.string(), z.unknown()).default({}),
        }),
      )
      .min(1),
  }),
  z.object({ answer: z.string() }),
]);

function toolPrompt(tools: ToolDef[]): string {
  const list = tools
    .map(
      (tool) =>
        `- ${tool.name}: ${tool.description}\n  arguments (JSON Schema): ${JSON.stringify(tool.parameters)}`,
    )
    .join("\n");
  return [
    "You can use these tools:",
    list,
    "",
    "Answer with exactly one JSON object and nothing else.",
    'To use tools: {"tool_calls": [{"name": "<tool>", "arguments": {...}}]}',
    'To reply to the user: {"answer": "<your reply>"}',
    "Tool results come back in a later message; then answer or call more tools.",
  ].join("\n");
}

/** Renders tool traffic as plain text, for models that never saw native tool messages. */
function flatten(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message): ChatMessage => {
    if (message.role === "assistant" && message.toolCalls?.length) {
      const calls = message.toolCalls.map((call) => ({
        name: call.name,
        arguments: JSON.parse(call.arguments || "{}"),
      }));
      return { role: "assistant", content: JSON.stringify({ tool_calls: calls }) };
    }
    if (message.role === "tool") {
      const status = message.isError ? "ERROR" : "OK";
      return {
        role: "user",
        content: `TOOL RESULT ${message.toolCallId} (${status}):\n${message.content}`,
      };
    }
    return message;
  });
}

const addUsage = (a: Usage | undefined, b: Usage | undefined): Usage | undefined =>
  a && b
    ? { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens }
    : (a ?? b);

let counter = 0;

/**
 * Gives tool calling to a model that has none: the tools are described in the prompt, the
 * model answers with JSON, the JSON is validated with zod, and one retry carries the
 * validation error back to the model. Callers see the same deltas as from a native model.
 */
export function withJsonToolFallback(engine: LlmEngine): LlmEngine {
  return {
    provider: engine.provider,
    model: engine.model,
    nativeTools: true,
    async *chat(req: ChatRequest): AsyncGenerator<ChatDelta> {
      if (!req.tools?.length) {
        yield* engine.chat(req);
        return;
      }
      const known = new Set(req.tools.map((tool) => tool.name));
      const { tools, ...rest } = req;
      const messages: ChatMessage[] = [
        ...flatten(req.messages),
        { role: "system", content: toolPrompt(tools) },
      ];
      let usage: Usage | undefined;

      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await collectChat(engine.chat({ ...rest, messages, json: true }));
        usage = addUsage(usage, result.usage);
        try {
          const parsed = answerSchema.parse(extractJson(result.text));
          if ("answer" in parsed) {
            yield { type: "text", text: parsed.answer };
            if (usage) yield { type: "usage", usage };
            yield { type: "done", finishReason: "stop" };
            return;
          }
          const unknown = parsed.tool_calls.filter((call) => !known.has(call.name));
          if (unknown.length)
            throw new Error(`unknown tool: ${unknown.map((call) => call.name).join(", ")}`);
          for (const call of parsed.tool_calls) {
            yield {
              type: "tool_call",
              call: {
                id: `json_${++counter}`,
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            };
          }
          if (usage) yield { type: "usage", usage };
          yield { type: "done", finishReason: "tool_calls" };
          return;
        } catch (error) {
          messages.push(
            { role: "assistant", content: result.text },
            {
              role: "user",
              content: `That answer could not be used: ${(error as Error).message.slice(0, 300)}. Answer again with one JSON object as described.`,
            },
          );
        }
      }
      // Two unusable answers: give up on tools and say so instead of inventing an action.
      yield { type: "text", text: "" };
      if (usage) yield { type: "usage", usage };
      yield { type: "done", finishReason: "stop" };
    },
  };
}
