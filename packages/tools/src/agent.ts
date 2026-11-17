import { randomUUID } from "node:crypto";
import {
  type AgentRunner,
  type ArtifactStore,
  type ChatMessage,
  type Command,
  type LlmEngine,
  loadPrompt,
  type MeetingSession,
  renderPrompt,
  type ToolCall,
  t,
} from "@open-meetings/core";
import { type MeetingSearch, type Tool, type ToolResult, toToolDef } from "./types";

export type AgentOptions = {
  llm: LlmEngine;
  tools: Tool[];
  artifacts: ArtifactStore;
  search?: MeetingSearch;
  fetch?: typeof fetch;
  /** Upper bound on model turns for one request. */
  maxSteps: number;
  /** Extra tools for one request (declared by the client that sent it). */
  toolsFor?: (command: Command) => Tool[];
  /** How much recent transcript the model gets, in characters. */
  transcriptChars?: number;
  promptOverrides?: Record<string, string>;
};

const CHAT_LIMIT = 600;

/** The call chat gets a short version; the whole answer is on the panel. */
export function shortenForChat(text: string, language: string): string {
  const clean = text.trim();
  if (clean.length <= CHAT_LIMIT) return clean;
  const head = clean.slice(0, CHAT_LIMIT - 100);
  const cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("\n"));
  return `${head.slice(0, cut > 200 ? cut + 1 : head.length).trim()} ${t(language, "fullAnswerInPanel")}`;
}

function recentTranscript(session: MeetingSession, maxChars: number): string {
  const lines: string[] = [];
  let used = 0;
  for (const segment of session.pipeline.segments.toReversed()) {
    const line = `[${segment.id}] ${segment.speaker}: ${segment.text}`;
    if (used + line.length > maxChars) break;
    lines.unshift(line);
    used += line.length;
  }
  return lines.join("\n") || "(nothing said yet)";
}

/**
 * The agent loop: the smart model works on a request with the meeting's tools until it has
 * an answer. Every step is published on the session's event stream, and any tool that acts
 * outside the meeting waits for a person's confirmation first.
 */
export function createAgent(options: AgentOptions): AgentRunner {
  async function execute(
    call: ToolCall,
    session: MeetingSession,
    runId: string,
    byName: Map<string, Tool>,
  ): Promise<ToolResult> {
    const tool = byName.get(call.name);
    if (!tool) return { content: `Unknown tool: ${call.name}`, isError: true };
    let args: unknown;
    try {
      args = tool.parse(JSON.parse(call.arguments || "{}"));
    } catch (error) {
      return { content: `Invalid arguments: ${(error as Error).message}`, isError: true };
    }
    if (tool.external) {
      const approved = await session.requestApproval(runId, {
        id: call.id,
        tool: tool.name,
        args,
        summary: tool.summarize(args),
      });
      if (!approved)
        return {
          content: "The people in the meeting did not confirm this action. Nothing was done.",
          isError: true,
        };
    }
    try {
      return await tool.run(args, {
        session,
        runId,
        callId: call.id,
        artifacts: options.artifacts,
        ...(options.search ? { search: options.search } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    } catch (error) {
      return { content: `The tool failed: ${(error as Error).message}`, isError: true };
    }
  }

  return {
    async run(command: Command, session: MeetingSession): Promise<string> {
      const runId = randomUUID();
      // Tools for this request only: the ones a client declared with it (AG-UI frontend tools).
      const tools = [...options.tools, ...(options.toolsFor?.(command) ?? [])];
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      const defs = tools.map(toToolDef);
      const { agentName, language, today } = session.options;
      session.publish({ type: "run_started", runId, command });

      // Answer from notes that include what was said right up to the request.
      session.pipeline.flush();
      await session.pipeline.idle();

      const system = renderPrompt(loadPrompt("agent", options.promptOverrides), {
        agentName,
        language,
        today: today ?? new Date().toISOString().slice(0, 10),
      });
      const messages: ChatMessage[] = [
        { role: "system", content: system, cache: true },
        {
          role: "user",
          content: [
            ...(session.options.memory
              ? [`PREVIOUS MEETING OF THIS SERIES:\n${session.options.memory}`]
              : []),
            `MEETING STATE:\n${JSON.stringify(session.pipeline.state)}`,
            `RECENT TRANSCRIPT:\n${recentTranscript(session, options.transcriptChars ?? 6000)}`,
            `REQUEST from ${command.from} (${command.via}):\n${command.request}`,
          ].join("\n\n"),
        },
      ];

      try {
        let answer = "";
        for (let step = 0; step < options.maxSteps; step++) {
          const messageId = `${runId}-${step}`;
          let text = "";
          const calls: ToolCall[] = [];
          const stream = options.llm.chat({
            messages,
            ...(defs.length ? { tools: defs } : {}),
            purpose: "agent",
          });
          for await (const delta of stream) {
            if (delta.type === "text") {
              text += delta.text;
              session.publish({ type: "agent_text", runId, messageId, delta: delta.text });
            } else if (delta.type === "tool_call") {
              calls.push(delta.call);
            } else if (delta.type === "usage") {
              session.publish({
                type: "usage",
                tier: "smart",
                model: options.llm.model,
                purpose: "agent",
                usage: delta.usage,
              });
            }
          }
          answer = text || answer;
          if (calls.length === 0) break;

          messages.push({ role: "assistant", content: text, toolCalls: calls });
          for (const call of calls) {
            session.publish({
              type: "tool_call",
              runId,
              callId: call.id,
              name: call.name,
              args: call.arguments,
            });
            const result = await execute(call, session, runId, byName);
            session.publish({
              type: "tool_result",
              runId,
              callId: call.id,
              content: result.content,
              ...(result.isError ? { isError: true } : {}),
            });
            messages.push({
              role: "tool",
              toolCallId: call.id,
              content: result.content,
              ...(result.isError ? { isError: true } : {}),
            });
          }
        }
        session.publish({ type: "run_finished", runId });
        return shortenForChat(answer || t(language, "failed"), language);
      } catch (error) {
        session.publish({ type: "run_error", runId, message: (error as Error).message });
        throw error;
      }
    },
  };
}
