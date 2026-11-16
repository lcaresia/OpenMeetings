import type { AudioChunk, TranscriptSegment } from "@open-meetings/core";

export type ToolCall = {
  id: string;
  name: string /** JSON-encoded arguments. */;
  arguments: string;
};

export type ChatMessage =
  | {
      role: "system";
      content: string /** Mark as a prompt-cache breakpoint when supported. */;
      cache?: boolean;
    }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string; isError?: boolean };

export type ToolDef = {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>;
};

export type ChatRequest = {
  messages: ChatMessage[];
  tools?: ToolDef[];
  /** Ignored by providers that removed sampling parameters. */
  temperature?: number;
  maxTokens?: number;
  /** Ask for a single JSON object as the whole answer. */
  json?: boolean;
  signal?: AbortSignal;
};

export type Usage = { inputTokens: number; outputTokens: number; cachedInputTokens?: number };

export type FinishReason = "stop" | "tool_calls" | "length" | "refusal";

export type ChatDelta =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; usage: Usage }
  | { type: "done"; finishReason: FinishReason };

export interface LlmEngine {
  readonly provider: string;
  readonly model: string;
  /** False when tools must go through the JSON fallback (see `withJsonToolFallback`). */
  readonly nativeTools: boolean;
  chat(req: ChatRequest): AsyncIterable<ChatDelta>;
}

export type SttOptions = {
  language?: string;
  speaker?: string;
  prompt?: string;
  signal?: AbortSignal;
};

export interface SttEngine {
  readonly model: string;
  transcribe(chunk: AudioChunk, opts?: SttOptions): Promise<TranscriptSegment[]>;
}

export type TtsOptions = { voice?: string; signal?: AbortSignal };

export interface TtsEngine {
  readonly model: string;
  synthesize(text: string, opts?: TtsOptions): Promise<ReadableStream<Uint8Array>>;
}

export interface EmbedEngine {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export type Engines = {
  llm: { fast: LlmEngine; smart: LlmEngine };
  stt?: SttEngine;
  tts?: TtsEngine;
  embed?: EmbedEngine;
};

export type ChatResult = {
  text: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  finishReason: FinishReason;
};

/** Drains a chat stream into a single result. */
export async function collectChat(stream: AsyncIterable<ChatDelta>): Promise<ChatResult> {
  const result: ChatResult = { text: "", toolCalls: [], finishReason: "stop" };
  for await (const delta of stream) {
    if (delta.type === "text") result.text += delta.text;
    else if (delta.type === "tool_call") result.toolCalls.push(delta.call);
    else if (delta.type === "usage") result.usage = delta.usage;
    else result.finishReason = delta.finishReason;
  }
  return result;
}
