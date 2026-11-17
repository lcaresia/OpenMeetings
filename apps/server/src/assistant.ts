import { randomUUID } from "node:crypto";
import type { Config } from "@open-meetings/config";
import { type ChatMessage, type Engines, loadPrompt, renderPrompt, t } from "@open-meetings/core";
import type { ManagerEvent, MeetingManager } from "./manager";

/**
 * Answers questions about meetings for clients that are not in one: the OpenAI-compatible
 * endpoint, the ACP agent, MCP tools. Two kinds of question:
 *
 * - live: a command in a meeting that is happening now (same path as a chat command).
 * - history: a question over past meetings, answered by the smart model from saved notes and
 *   semantic search.
 */
export class MeetingAssistant {
  constructor(
    private readonly manager: MeetingManager,
    private readonly engines: Engines,
    private readonly config: Config,
  ) {}

  /** The meeting a live question is about: the given one, or the most recent live meeting. */
  liveMeetingId(preferred?: string): string | undefined {
    if (preferred && this.manager.getLive(preferred)) return preferred;
    const live = this.manager.liveMeetings.sort((a, b) =>
      b.record.startedAt.localeCompare(a.record.startedAt),
    );
    return live[0]?.record.id;
  }

  /** Streams the answer to a command in a live meeting. */
  async *askLive(meetingId: string, text: string, from = "api"): AsyncGenerator<string> {
    const commandId = randomUUID();
    const queue: (string | null)[] = [];
    let wake: (() => void) | undefined;
    let agentRun: string | undefined;
    let streamed = false;
    const push = (item: string | null) => {
      queue.push(item);
      wake?.();
    };
    const language = this.config.agent.language;

    const unsubscribe = this.manager.subscribe(meetingId, (event: ManagerEvent) => {
      if (event.type === "run_started" && event.command.id === commandId) agentRun = event.runId;
      else if (event.type === "agent_text" && event.runId === agentRun) {
        streamed = true;
        push(event.delta);
      } else if (event.type === "approval_request" && event.runId === agentRun) {
        push(
          `\n[${t(language, "confirmPrefix")} ${event.request.summary}. ${t(language, "confirmHow")}]\n`,
        );
      } else if (event.type === "reply" && event.command?.id === commandId) {
        if (!streamed) push(event.text);
        push(null);
      } else if (event.type === "closed") push(null);
    });
    try {
      void this.manager.command(meetingId, text, { from, commandId }).catch((error: unknown) => {
        push(`${(error as Error).message}`);
        push(null);
      });
      for (;;) {
        if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
        const item = queue.shift();
        if (item === null) return;
        if (item !== undefined) yield item;
      }
    } finally {
      unsubscribe();
    }
  }

  /** Streams an answer over past meetings. */
  async *askHistory(messages: ChatMessage[]): AsyncGenerator<string> {
    const question = messages.findLast((message) => message.role === "user")?.content ?? "";
    const recent = this.manager.list({ limit: 10 }).map((record) => ({
      id: record.id,
      title: record.title ?? record.state.title,
      date: record.startedAt.slice(0, 10),
      status: record.status,
      decisions: record.state.decisions.map((d) => d.text),
      actionItems: record.state.actionItems.map((item) => ({
        text: item.text,
        owner: item.owner,
        due: item.due,
        status: item.status,
      })),
      openQuestions: record.state.openQuestions.map((q) => q.text),
      summary: record.state.rollingSummary,
    }));
    const passages = question ? await this.manager.search(question, 8).catch(() => []) : [];
    const system = renderPrompt(loadPrompt("history", this.config.prompts), {
      agentName: this.config.agent.name,
      language: this.config.agent.language,
    });
    const context = `MEETINGS:\n${JSON.stringify(recent)}\n\nPASSAGES:\n${passages
      .map((hit) => `[${hit.date}] ${hit.meetingTitle ?? hit.meetingId}: ${hit.text}`)
      .join("\n---\n")}`;
    const conversation = messages.filter(
      (message) => message.role === "user" || message.role === "assistant",
    );
    const stream = this.engines.llm.smart.chat({
      messages: [
        { role: "system", content: system, cache: true },
        { role: "system", content: context },
        ...conversation,
      ],
      purpose: "history",
    });
    for await (const delta of stream) if (delta.type === "text") yield delta.text;
  }
}
