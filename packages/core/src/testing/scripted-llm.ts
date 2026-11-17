import type { ChatDelta, ChatRequest, LlmEngine, ToolCall } from "../llm";

export type ScriptedTurn =
  | string
  | { text?: string; toolCalls?: { name: string; arguments: unknown }[] }
  | ((
      req: ChatRequest,
    ) => string | { text?: string; toolCalls?: { name: string; arguments: unknown }[] });

/**
 * A model that plays a fixed script, one turn per call: text, tool calls, or a function of the
 * request. Records every request so tests can check what the model was shown.
 */
export function createScriptedLlm(turns: ScriptedTurn[], options: { nativeTools?: boolean } = {}) {
  const calls: ChatRequest[] = [];
  let index = 0;
  let callCounter = 0;
  const engine: LlmEngine & { calls: ChatRequest[] } = {
    provider: "scripted",
    model: "scripted-llm",
    nativeTools: options.nativeTools ?? true,
    calls,
    async *chat(req: ChatRequest): AsyncGenerator<ChatDelta> {
      calls.push(structuredClone({ ...req, signal: undefined }));
      const turn = turns[Math.min(index++, turns.length - 1)] ?? "";
      const resolved = typeof turn === "function" ? turn(req) : turn;
      const step = typeof resolved === "string" ? { text: resolved } : resolved;
      if (step.text) yield { type: "text", text: step.text };
      const toolCalls: ToolCall[] = (step.toolCalls ?? []).map((call) => ({
        id: `call_${++callCounter}`,
        name: call.name,
        arguments:
          typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments),
      }));
      for (const call of toolCalls) yield { type: "tool_call", call };
      yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } };
      yield { type: "done", finishReason: toolCalls.length ? "tool_calls" : "stop" };
    },
  };
  return engine;
}
