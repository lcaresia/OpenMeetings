import type { FetchLike } from "./http";

export type RecordedRequest = { url: string; headers: Headers; body: unknown };

/** A fetch double: records every request and answers from a per-path handler. */
export function fakeFetch(handler: (request: RecordedRequest) => Response | Promise<Response>) {
  const requests: RecordedRequest[] = [];
  const fetchFn: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // keep the raw string
      }
    }
    const request = { url, headers, body };
    requests.push(request);
    return handler(request);
  };
  return { fetchFn, requests };
}

/** Builds a Server-Sent Events response. Strings are sent verbatim as `data:` payloads. */
export function sseResponse(events: (string | { event?: string; data: unknown })[]): Response {
  const text = events
    .map((item) => {
      if (typeof item === "string") return `data: ${item}\n\n`;
      const head = item.event ? `event: ${item.event}\n` : "";
      return `${head}data: ${JSON.stringify(item.data)}\n\n`;
    })
    .join("");
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

/** OpenAI-style streamed answer made of plain text. */
export function openAiTextStream(
  text: string,
  usage = { prompt_tokens: 12, completion_tokens: 3 },
) {
  return sseResponse([
    JSON.stringify({ choices: [{ delta: { role: "assistant", content: text } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    JSON.stringify({ choices: [], usage }),
    "[DONE]",
  ]);
}

/** Anthropic Messages API streamed answer: optional text block, optional tool_use block. */
export function anthropicStream(options: {
  text?: string;
  tool?: { id: string; name: string; input: unknown };
  stopReason?: string;
  usage?: Record<string, number>;
}): Response {
  const events: { event: string; data: unknown }[] = [];
  const push = (data: { type: string } & Record<string, unknown>) =>
    events.push({ event: data.type, data });
  push({
    type: "message_start",
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1, ...options.usage },
    },
  });
  let index = 0;
  if (options.text !== undefined) {
    push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
    push({ type: "content_block_delta", index, delta: { type: "text_delta", text: options.text } });
    push({ type: "content_block_stop", index });
    index++;
  }
  if (options.tool) {
    const { id, name, input } = options.tool;
    push({
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id, name, input: {} },
    });
    push({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    });
    push({ type: "content_block_stop", index });
  }
  push({
    type: "message_delta",
    delta: {
      stop_reason: options.stopReason ?? (options.tool ? "tool_use" : "end_turn"),
      stop_sequence: null,
    },
    usage: { output_tokens: 20 },
  });
  push({ type: "message_stop" });
  return sseResponse(events);
}
