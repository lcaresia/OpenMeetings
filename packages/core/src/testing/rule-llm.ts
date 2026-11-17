import { quickIntent } from "../commands";
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
    // A question about decisions is not a decision.
    if (DECISION.test(line.text) && !line.text.trim().endsWith("?")) {
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

/** Routes a request by keyword; anything unrecognized goes to the agent. */
function intent(req: ChatRequest): string {
  const user = req.messages.findLast((message) => message.role === "user")?.content ?? "";
  const request = user.split("\nSaid: ")[1] ?? "";
  return JSON.stringify({ intent: quickIntent(request) ?? "agent", request });
}

type AgentTurn = { text?: string; toolCalls?: { name: string; arguments: unknown }[] };

const WEEKDAYS = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];

/** Turns "sexta-feira" or "2026-11-20" into a date, counting from `today`. */
function dueDate(due: string | undefined, today: string, fallbackDays: number): string {
  if (due && /^\d{4}-\d{2}-\d{2}$/.test(due)) return due;
  const base = new Date(`${today}T12:00:00Z`);
  const name = (due ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const weekday = WEEKDAYS.findIndex((day) => name.startsWith(day));
  const days = weekday === -1 ? fallbackDays : (weekday - base.getUTCDay() + 7) % 7 || 7;
  return new Date(base.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Builds artifacts from the notes with fixed rules, so the demo (`om serve --demo --mock`) and
 * the end-to-end tests exercise every tool without a model.
 */
function agentTurn(req: ChatRequest): AgentTurn {
  const last = req.messages.at(-1);
  if (last?.role === "tool") {
    return { text: last.isError ? `Não consegui: ${last.content}` : `Pronto. ${last.content}` };
  }
  const user = req.messages.findLast((message) => message.role === "user")?.content ?? "";
  const system = req.messages.find((message) => message.role === "system")?.content ?? "";
  const today = /\d{4}-\d{2}-\d{2}/.exec(system)?.[0] ?? new Date().toISOString().slice(0, 10);
  const request = (/REQUEST from [^\n]*\n([\s\S]*)$/.exec(user)?.[1] ?? user).toLowerCase();
  let state: {
    decisions?: { text: string }[];
    actionItems?: { text: string; owner?: string; due?: string; status?: string }[];
  } = {};
  try {
    state = JSON.parse(/MEETING STATE:\n(.*)\n/.exec(user)?.[1] ?? "{}");
  } catch {
    // keep the empty notes
  }
  const items = state.actionItems ?? [];
  const decisions = state.decisions ?? [];

  if (/cronograma|timeline|gantt/.test(request)) {
    return {
      toolCalls: [
        {
          name: "create_timeline",
          arguments: {
            title: "Cronograma",
            tasks: items.map((item, i) => ({
              name: item.text,
              ...(item.owner ? { owner: item.owner } : {}),
              start: today,
              end: dueDate(item.due, today, 7 + i * 3),
            })),
          },
        },
      ],
    };
  }
  if (/quadro|board|kanban/.test(request)) {
    const owners = [...new Set(items.map((item) => item.owner ?? "Sem responsável"))];
    return {
      toolCalls: [
        {
          name: "create_board",
          arguments: {
            title: "Quadro de tarefas",
            columns: [
              ...owners.map((owner) => ({
                title: owner,
                cards: items
                  .filter((item) => (item.owner ?? "Sem responsável") === owner)
                  .map((item) => item.text),
              })),
              { title: "Decisões", cards: decisions.map((decision) => decision.text) },
            ],
          },
        },
      ],
    };
  }
  if (/planilha|tabela|sheet|spreadsheet/.test(request)) {
    return {
      toolCalls: [
        {
          name: "create_sheet",
          arguments: {
            title: "Itens de ação",
            columns: ["Item", "Responsável", "Prazo", "Status"],
            rows: items.map((item) => [
              item.text,
              item.owner ?? "",
              item.due ?? "",
              item.status ?? "open",
            ]),
          },
        },
      ],
    };
  }
  if (/documento|doc|plano|relatorio|relatório|brief/.test(request)) {
    const markdown = [
      "# Plano",
      "",
      "## Decisões",
      ...decisions.map((decision) => `- ${decision.text}`),
      "",
      "## Próximos passos",
      ...items.map(
        (item) => `- **${item.owner ?? "?"}**: ${item.text}${item.due ? ` (até ${item.due})` : ""}`,
      ),
    ].join("\n");
    return { toolCalls: [{ name: "create_doc", arguments: { title: "Plano", markdown } }] };
  }
  return { text: "No modo de demonstração eu sei criar cronograma, quadro, planilha e documento." };
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
  const builtin: Record<string, Responder> = { "state-update": stateUpdate, intent };

  return {
    provider: "rule",
    model: "rule-llm",
    nativeTools: true,
    calls,
    async *chat(req: ChatRequest): AsyncGenerator<ChatDelta> {
      calls.push(req);
      const purpose = req.purpose ?? "";
      const custom = responders[purpose] ?? builtin[purpose];
      const turn: AgentTurn = custom
        ? { text: custom(req) ?? "" }
        : purpose === "agent" && req.tools?.length
          ? agentTurn(req)
          : {};
      const text = turn.text ?? "";
      if (text) yield { type: "text", text };
      for (const [i, call] of (turn.toolCalls ?? []).entries()) {
        yield {
          type: "tool_call",
          call: {
            id: `rule_${calls.length}_${i}`,
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        };
      }
      const inputChars = req.messages.reduce((sum, message) => sum + message.content.length, 0);
      yield {
        type: "usage",
        usage: { inputTokens: Math.ceil(inputChars / 4), outputTokens: Math.ceil(text.length / 4) },
      };
      yield { type: "done", finishReason: turn.toolCalls?.length ? "tool_calls" : "stop" };
    },
  };
}
