import type { ChatDelta, ChatRequest, LlmEngine } from "../llm";

type Line = { id: string; speaker: string; text: string };
type Responder = (req: ChatRequest) => string | undefined;

const DECISION =
  /\b(fica decidido|ficou decidido|decidimos|decidido que|we decided|it is decided)\b/i;
const ASSIGNED =
  /^([A-ZÀ-Ú][\wÀ-ú]+), (?:você|voce|you) (?:fica responsável por|pode|vai|will|are going to) (.+)$/i;
const TAKEN = /\b(?:eu fico responsável por|eu vou|eu me comprometo a|i will|i'll take) (.+)$/i;
const DUE = /\s+(?:até|ate|by) (?:a |o )?([\wÀ-ú-]+(?: de [\wÀ-ú]+)?)[.!]?$/i;
const QUESTION = /\b(alguém sabe|alguem sabe|does anyone know)\b/i;

function parseTranscript(content: string): Line[] {
  const block = content.split("NEW TRANSCRIPT:\n")[1] ?? "";
  const lines: Line[] = [];
  for (const raw of block.split("\n")) {
    const match = /^\[([^\]]+)\] ([^:]+): (.*)$/.exec(raw);
    if (match?.[1] && match[2] && match[3] !== undefined) {
      lines.push({ id: match[1], speaker: match[2], text: match[3] });
    }
  }
  return lines;
}

function task(text: string): { text: string; due?: string } {
  const due = DUE.exec(text);
  const body = (due ? text.slice(0, due.index) : text).replace(/[.!]$/, "").trim();
  return due?.[1] ? { text: body, due: due[1] } : { text: body };
}

/** Writes the patch a careful model would, using plain pattern rules. */
function stateUpdate(req: ChatRequest): string {
  const user = req.messages.findLast((message) => message.role === "user")?.content ?? "";
  const ops: unknown[] = [];
  const lines = parseTranscript(user);

  for (const line of lines) {
    const cite = { sourceSegmentIds: [line.id] };
    const assigned = ASSIGNED.exec(line.text);
    const taken = TAKEN.exec(line.text);
    if (DECISION.test(line.text)) {
      ops.push({
        op: "add",
        path: "/decisions/-",
        value: { text: line.text, by: line.speaker, ...cite },
      });
    } else if (assigned?.[1] && assigned[2]) {
      ops.push({
        op: "add",
        path: "/actionItems/-",
        value: { ...task(assigned[2]), owner: assigned[1], ...cite },
      });
    } else if (taken?.[1]) {
      ops.push({
        op: "add",
        path: "/actionItems/-",
        value: { ...task(taken[1]), owner: line.speaker, ...cite },
      });
    } else if (QUESTION.test(line.text)) {
      ops.push({ op: "add", path: "/openQuestions/-", value: { text: line.text, ...cite } });
    }
  }
  const last = lines.at(-1);
  if (last) {
    ops.push({
      op: "replace",
      path: "/rollingSummary",
      value: `Última fala de ${last.speaker}: ${last.text}`,
    });
  }
  return JSON.stringify({ patch: ops });
}

/**
 * A deterministic stand-in for a language model, for CI. It answers each kind of call
 * (`ChatRequest.purpose`) with fixed rules, so the whole pipeline runs with no network, no
 * cost, and the same result every time. Extra responders override or extend the built-in ones.
 */
export function createRuleLlm(
  responders: Record<string, Responder> = {},
): LlmEngine & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  const builtin: Record<string, Responder> = { "state-update": stateUpdate };

  return {
    provider: "rule",
    model: "rule-llm",
    nativeTools: true,
    calls,
    async *chat(req: ChatRequest): AsyncGenerator<ChatDelta> {
      calls.push(req);
      const purpose = req.purpose ?? "";
      const text = (responders[purpose] ?? builtin[purpose])?.(req) ?? "";
      if (text) yield { type: "text", text };
      const inputChars = req.messages.reduce((sum, message) => sum + message.content.length, 0);
      yield {
        type: "usage",
        usage: { inputTokens: Math.ceil(inputChars / 4), outputTokens: Math.ceil(text.length / 4) },
      };
      yield { type: "done", finishReason: "stop" };
    },
  };
}
