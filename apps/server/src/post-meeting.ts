import {
  collectChat,
  type LlmEngine,
  loadPrompt,
  type MeetingState,
  renderPrompt,
  type TranscriptSegment,
  t,
  type Usage,
} from "@open-meetings/core";
import type { FetchLike } from "@open-meetings/engines";
import type { Chunk, MeetingRecord } from "./storage/store";

export type MinutesInput = {
  title?: string;
  startedAt: string;
  state: MeetingState;
  segments: TranscriptSegment[];
  language: string;
};

function itemLine(language: string, item: MeetingState["actionItems"][number]): string {
  const details = [
    item.owner ? `${t(language, "owner")}: ${item.owner}` : "",
    item.due ? `${t(language, "due")}: ${item.due}` : "",
    item.status === "done" ? t(language, "done") : "",
  ].filter(Boolean);
  return `${item.text}${details.length ? ` (${details.join(", ")})` : ""}`;
}

/**
 * The final minutes in Markdown. Only the summary paragraph is written by a model; decisions,
 * action items and questions are copied from the notes, so the minutes never drift from what
 * the panel showed during the meeting.
 */
export function renderMinutes(input: MinutesInput, summary: string): string {
  const { state, language } = input;
  const list = (items: string[]) =>
    items.length ? items.map((item) => `- ${item}`).join("\n") : t(language, "minutesNone");
  const date = input.startedAt.slice(0, 10);
  const sections = [
    `# ${t(language, "minutesTitle")}: ${input.title ?? state.title ?? date}`,
    `${date} · ${t(language, "minutesParticipants")}: ${state.participants.map((p) => p.name).join(", ") || "-"}`,
    `## ${t(language, "minutesSummary")}\n\n${summary || state.rollingSummary || t(language, "minutesNone")}`,
    `## ${t(language, "minutesDecisions")}\n\n${list(state.decisions.map((d) => (d.by ? `${d.text} (${d.by})` : d.text)))}`,
    `## ${t(language, "minutesActionItems")}\n\n${list(state.actionItems.map((item) => itemLine(language, item)))}`,
    `## ${t(language, "minutesOpenQuestions")}\n\n${list(state.openQuestions.map((q) => q.text))}`,
  ];
  if (state.artifacts.length) {
    sections.push(
      `## ${t(language, "minutesArtifacts")}\n\n${list(state.artifacts.map((a) => `[${a.title ?? a.type}](${a.url})`))}`,
    );
  }
  return `${sections.join("\n\n")}\n`;
}

/** Asks the smart model for the summary paragraph; falls back to the running summary. */
export async function writeSummary(
  llm: LlmEngine,
  input: MinutesInput,
  options: { promptOverrides?: Record<string, string>; onUsage?: (usage: Usage) => void } = {},
): Promise<string> {
  if (input.segments.length === 0) return input.state.rollingSummary;
  try {
    const transcript = input.segments
      .map((segment) => `${segment.speaker}: ${segment.text}`)
      .join("\n")
      // Long meetings: the notes carry the structure, the transcript only adds color.
      .slice(-40_000);
    const result = await collectChat(
      llm.chat({
        messages: [
          {
            role: "system",
            content: renderPrompt(loadPrompt("minutes", options.promptOverrides), {
              language: input.language,
            }),
            cache: true,
          },
          {
            role: "user",
            content: `NOTES:\n${JSON.stringify(input.state)}\n\nTRANSCRIPT:\n${transcript}`,
          },
        ],
        maxTokens: 1200,
        purpose: "minutes",
      }),
    );
    if (result.usage) options.onUsage?.(result.usage);
    return result.text.trim() || input.state.rollingSummary;
  } catch {
    return input.state.rollingSummary;
  }
}

const CHAT_LIMIT = 900;

/** The short version posted in the call chat before leaving. */
export function minutesForChat(state: MeetingState, language: string): string {
  const lines = [t(language, "minutesChatIntro")];
  if (state.decisions.length) {
    lines.push(`${t(language, "minutesDecisions")}:`, ...state.decisions.map((d) => `- ${d.text}`));
  }
  if (state.actionItems.length) {
    lines.push(
      `${t(language, "minutesActionItems")}:`,
      ...state.actionItems.map((item) => `- ${itemLine(language, item)}`),
    );
  }
  if (state.openQuestions.length) {
    lines.push(
      `${t(language, "minutesOpenQuestions")}:`,
      ...state.openQuestions.map((q) => `- ${q.text}`),
    );
  }
  let text = lines.join("\n");
  if (text.length > CHAT_LIMIT) text = `${text.slice(0, CHAT_LIMIT - 3).trimEnd()}...`;
  return `${text}\n${t(language, "minutesChatOutro")}`;
}

/** Splits a meeting into the passages that get embedded for search. */
export function searchChunks(
  state: MeetingState,
  segments: TranscriptSegment[],
  minutes: string,
): Omit<Chunk, "embedding">[] {
  const chunks: Omit<Chunk, "embedding">[] = [];
  let buffer = "";
  for (const segment of segments) {
    const line = `${segment.speaker}: ${segment.text}`;
    if (buffer && buffer.length + line.length > 800) {
      chunks.push({ kind: "transcript", text: buffer });
      buffer = "";
    }
    buffer = buffer ? `${buffer}\n${line}` : line;
  }
  if (buffer) chunks.push({ kind: "transcript", text: buffer });
  for (const decision of state.decisions) chunks.push({ kind: "decision", text: decision.text });
  for (const item of state.actionItems) {
    chunks.push({
      kind: "action",
      text: `${item.text}${item.owner ? ` (${item.owner})` : ""}${item.due ? `, ${item.due}` : ""}`,
    });
  }
  for (const part of minutes.split(/\n(?=## )/)) {
    if (part.trim()) chunks.push({ kind: "minutes", text: part.trim().slice(0, 2000) });
  }
  return chunks;
}

/** Context handed to the agent at the start of a recurring meeting. */
export function previousMeetingMemory(previous: MeetingRecord): string {
  const { state } = previous;
  const pending = state.actionItems.filter((item) => item.status !== "done");
  return JSON.stringify({
    title: previous.title ?? state.title,
    date: previous.startedAt.slice(0, 10),
    decisions: state.decisions.map((d) => d.text),
    pendingActionItems: pending.map((item) => ({
      text: item.text,
      owner: item.owner,
      due: item.due,
    })),
    openQuestions: state.openQuestions.map((q) => q.text),
    summary: state.rollingSummary,
  });
}

/** Same link means same meeting series; without a link, the same title. */
export function seriesKeyFor(url?: string, title?: string): string | undefined {
  if (url) {
    try {
      const parsed = new URL(url);
      return `${parsed.hostname}${parsed.pathname}`.toLowerCase().replace(/\/+$/, "");
    } catch {
      return url.toLowerCase();
    }
  }
  return title ? `title:${title.trim().toLowerCase()}` : undefined;
}

export type WebhookPayload = {
  event: "meeting.ended";
  meeting: {
    id: string;
    title?: string;
    url?: string;
    startedAt: string;
    endedAt: string;
    costUsd: number;
  };
  minutes: string;
  state: MeetingState;
};

export async function sendWebhook(
  url: string,
  payload: WebhookPayload,
  fetchFn: FetchLike,
): Promise<void> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "open-meetings" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`webhook answered HTTP ${res.status}`);
}
