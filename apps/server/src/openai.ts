import { randomUUID } from "node:crypto";
import type { ChatMessage } from "@open-meetings/core";
import type { MeetingAssistant } from "./assistant";
import { HttpError, type Router } from "./http";

/**
 * An OpenAI-compatible endpoint whose "models" are the meeting agent. Any client that accepts
 * an OpenAI base URL (OpenBot included) can talk to meetings with no specific integration.
 *
 * - open-meetings/live: a command in the live meeting (`meeting_id` in the body, or the most
 *   recent live meeting).
 * - open-meetings/history: questions about past meetings.
 */
export const MODELS = [
  { id: "open-meetings/live", description: "Ask or command the meeting happening now" },
  { id: "open-meetings/history", description: "Ask about past meetings" },
] as const;

type OpenAiMessage = { role: string; content: string | { type: string; text?: string }[] | null };
type CompletionRequest = {
  model?: string;
  messages?: OpenAiMessage[];
  stream?: boolean;
  meeting_id?: string;
  metadata?: { meeting_id?: string };
};

const textOf = (content: OpenAiMessage["content"]) =>
  typeof content === "string"
    ? content
    : (content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");

export function registerOpenAi(router: Router, assistant: MeetingAssistant, base = "/v1"): void {
  const created = Math.floor(Date.now() / 1000);

  router.add("GET", `${base}/models`, () => ({
    object: "list",
    data: MODELS.map((model) => ({
      id: model.id,
      object: "model",
      created,
      owned_by: "open-meetings",
    })),
  }));

  router.add("POST", `${base}/chat/completions`, async ({ body, res }) => {
    const input = (await body()) as CompletionRequest;
    const model = input.model ?? MODELS[0].id;
    if (!MODELS.some((m) => m.id === model)) {
      throw new HttpError(
        404,
        `unknown model ${model}; use ${MODELS.map((m) => m.id).join(" or ")}`,
      );
    }
    const messages: ChatMessage[] = (input.messages ?? [])
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: textOf(m.content) }));
    const question = messages.findLast((m) => m.role === "user")?.content.trim();
    if (!question) throw new HttpError(400, "messages must end with a user message");

    let chunks: AsyncGenerator<string>;
    if (model === "open-meetings/live") {
      const meetingId = assistant.liveMeetingId(input.meeting_id ?? input.metadata?.meeting_id);
      chunks = meetingId
        ? assistant.askLive(meetingId, question)
        : (async function* () {
            yield "There is no live meeting right now. Ask open-meetings/history about past meetings.";
          })();
    } else {
      chunks = assistant.askHistory(messages);
    }

    const id = `chatcmpl-${randomUUID()}`;
    const now = Math.floor(Date.now() / 1000);
    if (!input.stream) {
      let text = "";
      for await (const chunk of chunks) text += chunk;
      return {
        id,
        object: "chat.completion",
        created: now,
        model,
        choices: [
          { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const write = (delta: Record<string, unknown>, finish: string | null) =>
      res.write(
        `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: now, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
      );
    write({ role: "assistant", content: "" }, null);
    try {
      for await (const chunk of chunks) write({ content: chunk }, null);
      write({}, "stop");
    } catch (error) {
      write({ content: `\n[error: ${(error as Error).message}]` }, "stop");
    }
    res.end("data: [DONE]\n\n");
    return undefined;
  });
}
