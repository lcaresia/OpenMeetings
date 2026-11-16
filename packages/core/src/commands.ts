import { z } from "zod";
import { t } from "./i18n";
import { collectChat, extractJson, type LlmEngine, type Usage } from "./llm";
import { loadPrompt, renderPrompt } from "./prompts";
import type { MeetingState } from "./state";

export const INTENTS = [
  "summary",
  "decisions",
  "action_items",
  "pause",
  "resume",
  "leave",
  "agent",
  "none",
  // Answers to a pending confirmation. Only ever produced by literal chat words.
  "approve",
  "deny",
] as const;
export type Intent = (typeof INTENTS)[number];

export type Command = {
  intent: Intent;
  /** The request restated as a standalone instruction. */
  request: string;
  from: string;
  via: "voice" | "chat" | "panel";
  atMs: number;
  sourceSegmentId?: string;
};

/** Lowercase, no accents, punctuation as spaces. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(above + 1, (row[j - 1] ?? 0) + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return row[b.length] ?? 0;
}

/**
 * Finds a wake word in a sentence and returns what was said after it. Matching is fuzzy on
 * purpose: captions often mishear the name ("open meeting", "opem meetings"). Costs nothing,
 * so it runs on every line; a model is only consulted after a match.
 */
export function matchWakeWord(text: string, wakeWords: string[]): { rest: string } | undefined {
  const words = [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    norm: normalizeText(match[0]),
    end: (match.index ?? 0) + match[0].length,
  }));
  for (const wake of wakeWords) {
    const target = normalizeText(wake);
    const size = target.split(" ").length;
    const tolerance = Math.floor(target.length / 6);
    for (let start = 0; start + size <= words.length; start++) {
      const window = words.slice(start, start + size);
      const candidate = window.map((word) => word.norm).join(" ");
      if (editDistance(candidate, target) > tolerance) continue;
      const end = window.at(-1)?.end ?? text.length;
      return { rest: text.slice(end).replace(/^[\s,.:;!?-]+/, "") };
    }
  }
  return undefined;
}

const EXACT_CHAT: Record<string, Intent> = {
  sair: "leave",
  saia: "leave",
  leave: "leave",
  exit: "leave",
  pausar: "pause",
  pause: "pause",
  pausa: "pause",
  continuar: "resume",
  retomar: "resume",
  resume: "resume",
  sim: "approve",
  yes: "approve",
  confirmar: "approve",
  confirmo: "approve",
  ok: "approve",
  nao: "deny",
  no: "deny",
  cancelar: "deny",
  cancel: "deny",
};

/**
 * Chat commands. `om sair`, `om pausar` and `om continuar` are matched literally and never
 * depend on a model: a participant must always be able to send the assistant away.
 */
export function parseChatCommand(
  text: string,
  wakeWords: string[],
): { request: string; exact?: Intent } | undefined {
  const prefixed = /^\s*om[\s,:]+(.+)$/i.exec(text);
  if (prefixed?.[1]) {
    const request = prefixed[1].trim();
    const exact = EXACT_CHAT[normalizeText(request)];
    return exact ? { request, exact } : { request };
  }
  const wake = matchWakeWord(text, wakeWords);
  return wake?.rest ? { request: wake.rest } : undefined;
}

const QUICK: [RegExp, Intent][] = [
  [/\b(sair|saia|sai da|leave|go away)\b/, "leave"],
  [/\b(pausar|pause|pausa|pare de (ouvir|transcrever)|stop (listening|transcribing))\b/, "pause"],
  [/\b(continuar|retomar|resume|volte a (ouvir|transcrever))\b/, "resume"],
  [/\b(itens de acao|action items|tarefas|pendencias|to ?dos?)\b/, "action_items"],
  [/\b(o que (foi )?decidi(mos|do)|decisoes|decisions|what (did we|was) decide)/, "decisions"],
  [/\b(resumo|resuma|resumir|summary|summarize|recap)\b/, "summary"],
];

/** Keyword routing, used when the model is unavailable. */
export function quickIntent(request: string): Intent | undefined {
  const text = normalizeText(request);
  // "Summarize and email it" needs the agent; keywords alone would stop at the summary.
  if (/\b(e|and|depois|then)\b.*\b(envi|mand|cri|send|create|email|post)/.test(text))
    return undefined;
  return QUICK.find(([pattern]) => pattern.test(text))?.[1];
}

const intentSchema = z.object({
  // A model may not approve or deny an action on someone's behalf.
  intent: z.enum(INTENTS).exclude(["approve", "deny"]),
  request: z.string().default(""),
});

export type IntentOptions = {
  agentName: string;
  language: string;
  promptOverrides?: Record<string, string>;
  onUsage?: (usage: Usage) => void;
};

/** Asks the fast model what a request is for. Falls back to keywords, then to the agent. */
export async function classifyIntent(
  llm: LlmEngine,
  speaker: string,
  request: string,
  options: IntentOptions,
): Promise<{ intent: Intent; request: string }> {
  try {
    const system = renderPrompt(loadPrompt("intent", options.promptOverrides), {
      agentName: options.agentName,
      language: options.language,
    });
    const result = await collectChat(
      llm.chat({
        messages: [
          { role: "system", content: system, cache: true },
          { role: "user", content: `Speaker: ${speaker}\nSaid: ${request}` },
        ],
        json: true,
        maxTokens: 300,
        purpose: "intent",
      }),
    );
    if (result.usage) options.onUsage?.(result.usage);
    const parsed = intentSchema.parse(extractJson(result.text));
    return { intent: parsed.intent, request: parsed.request || request };
  } catch {
    return { intent: quickIntent(request) ?? "agent", request };
  }
}

/** Answers the built-in read-only commands straight from the state: no model, no latency. */
export function answerFromState(
  intent: "summary" | "decisions" | "action_items",
  state: MeetingState,
  language: string,
): string {
  if (intent === "decisions") {
    if (state.decisions.length === 0) return t(language, "noDecisions");
    return [
      t(language, "decisionsHeader"),
      ...state.decisions.map((d, i) => `${i + 1}. ${d.text}`),
    ].join("\n");
  }
  if (intent === "action_items") {
    if (state.actionItems.length === 0) return t(language, "noActionItems");
    return [
      t(language, "actionItemsHeader"),
      ...state.actionItems.map((item, i) => {
        const details = [
          item.owner ? `${t(language, "owner")}: ${item.owner}` : "",
          item.due ? `${t(language, "due")}: ${item.due}` : "",
          item.status === "done" ? t(language, "done") : "",
        ].filter(Boolean);
        return `${i + 1}. ${item.text}${details.length ? ` (${details.join(", ")})` : ""}`;
      }),
    ].join("\n");
  }
  return state.rollingSummary
    ? `${t(language, "summaryHeader")} ${state.rollingSummary}`
    : t(language, "noSummary");
}
