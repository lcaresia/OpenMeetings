import { randomUUID } from "node:crypto";
import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/core";
import type { Command } from "@open-meetings/core";
import type { Tool, ToolResult } from "@open-meetings/tools";
import type { ManagerEvent, MeetingManager } from "./manager";

/**
 * AG-UI adapter (ADR 0005). One POST is one run; the response is a stream of AG-UI events.
 *
 * - `threadId` is the meeting id. `forwardedProps.meetingUrl` starts a new meeting instead.
 * - A run with a new user message is a command: it streams that agent run and finishes.
 * - A run with nothing new subscribes to the meeting: STATE_SNAPSHOT, the transcript so far as
 *   `om.transcript` CUSTOM events, then everything live until the meeting ends.
 * - An action that needs a person's confirmation ends a command run with an `interrupt`
 *   outcome; the client answers with a new run carrying `resume`, which streams the rest.
 */

type Emit = (event: BaseEvent & Record<string, unknown>) => void;

export type AguiRun = {
  input: RunAgentInput;
  emit: Emit;
  /** Resolves when the client goes away. */
  closed: Promise<void>;
};

const custom = (name: string, value: unknown) => ({ type: EventType.CUSTOM, name, value });

function lastUserText(input: RunAgentInput): string | undefined {
  const last = input.messages.at(-1);
  if (last?.role !== "user") return undefined;
  if (typeof last.content === "string") return last.content;
  return last.content
    .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
    .join("");
}

/** Approval id -> agent run waiting on it, so a resume knows what to follow. */
const waitingRuns = new Map<string, { meetingId: string; runId: string }>();

/** Frontend tool calls waiting for the client to send their result in a later run. */
const clientCalls = new Map<string, { runId: string; resolve: (result: ToolResult) => void }>();

const CLIENT_TOOL_TIMEOUT_MS = 5 * 60_000;

/**
 * Tools the AG-UI client declared with its request. The agent calls them like any other tool;
 * the run then ends with `pendingToolCallIds`, the client runs the tool and starts a new run
 * whose last message is the tool result, and the agent carries on from there.
 */
function frontendTools(declared: RunAgentInput["tools"]): Tool[] {
  return declared.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: (tool.parameters as Record<string, unknown> | undefined) ?? {
      type: "object",
      properties: {},
    },
    parse: (args) => args ?? {},
    external: false,
    summarize: () => tool.name,
    run: (_args, context) =>
      new Promise<ToolResult>((resolve) => {
        const timer = setTimeout(() => {
          clientCalls.delete(context.callId);
          resolve({ content: "The client did not run this tool in time.", isError: true });
        }, CLIENT_TOOL_TIMEOUT_MS);
        clientCalls.set(context.callId, {
          runId: context.runId,
          resolve: (result) => {
            clearTimeout(timer);
            resolve(result);
          },
        });
      }),
  }));
}

export async function handleAguiRun(manager: MeetingManager, run: AguiRun): Promise<void> {
  const { input, emit } = run;
  const props = (input.forwardedProps ?? {}) as { meetingUrl?: string; title?: string };
  let meetingId = input.threadId;

  if (props.meetingUrl) {
    try {
      const live = manager.start({
        url: props.meetingUrl,
        ...(props.title ? { title: props.title } : {}),
      });
      meetingId = live.record.id;
    } catch (error) {
      emit({ type: EventType.RUN_ERROR, message: (error as Error).message, code: "start_failed" });
      return;
    }
  }

  const record = manager.get(meetingId);
  if (!record) {
    emit({
      type: EventType.RUN_ERROR,
      message: `No meeting with id ${meetingId}`,
      code: "not_found",
    });
    return;
  }

  emit({ type: EventType.RUN_STARTED, threadId: meetingId, runId: input.runId });
  const live = manager.getLive(meetingId);

  if (input.resume?.length) {
    if (!live) {
      emit({ type: EventType.RUN_ERROR, message: "The meeting has ended", code: "not_live" });
      return;
    }
    let follow: string | undefined;
    for (const entry of input.resume) {
      const payload = (entry.payload ?? {}) as { approved?: boolean };
      const approved = entry.status === "resolved" && payload.approved !== false;
      manager.resolveApproval(meetingId, entry.interruptId, approved, "agui");
      follow ??= waitingRuns.get(entry.interruptId)?.runId;
      waitingRuns.delete(entry.interruptId);
    }
    await streamCommand(manager, meetingId, run, { followRunId: follow });
    return;
  }

  // A frontend tool's result: hand it to the waiting agent run and stream the rest of it.
  const last = input.messages.at(-1);
  if (last?.role === "tool" && clientCalls.has(last.toolCallId)) {
    const call = clientCalls.get(last.toolCallId);
    clientCalls.delete(last.toolCallId);
    const content = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
    call?.resolve({ content: last.error ?? content, ...(last.error ? { isError: true } : {}) });
    await streamCommand(manager, meetingId, run, { followRunId: call?.runId });
    return;
  }

  const text = lastUserText(input);
  if (text && live) {
    await streamCommand(manager, meetingId, run, { text });
    return;
  }
  if (text && !live) {
    emit({
      type: EventType.RUN_ERROR,
      message: "The meeting has ended; ask the history endpoint instead",
      code: "not_live",
    });
    return;
  }

  await streamSubscription(manager, meetingId, run);
}

/** Streams one command: the agent's text, its tool calls, an interrupt or the final reply. */
async function streamCommand(
  manager: MeetingManager,
  meetingId: string,
  run: AguiRun,
  target: { text?: string; followRunId?: string | undefined },
): Promise<void> {
  const { emit, input } = run;
  const commandId = randomUUID();
  let agentRunId = target.followRunId;
  let messageId: string | undefined;
  let finished = false;
  const clientToolNames = new Set(input.tools.map((tool) => tool.name));

  await new Promise<void>((resolve) => {
    const finish = (outcome?: Record<string, unknown>) => {
      if (finished) return;
      finished = true;
      if (messageId) emit({ type: EventType.TEXT_MESSAGE_END, messageId });
      emit({
        type: EventType.RUN_FINISHED,
        threadId: meetingId,
        runId: input.runId,
        ...(outcome ? { outcome } : {}),
      });
      unsubscribe();
      resolve();
    };
    const text = (delta: string) => {
      if (!messageId) {
        messageId = randomUUID();
        emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" });
      }
      emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta });
    };
    const mine = (command: Command | undefined) => command?.id === commandId;

    const unsubscribe = manager.subscribe(meetingId, (event: ManagerEvent) => {
      if (event.type === "run_started" && mine(event.command)) agentRunId = event.runId;
      const ours = "runId" in event && event.runId === agentRunId && agentRunId !== undefined;
      if (event.type === "agent_text" && ours) text(event.delta);
      else if (event.type === "tool_call" && ours) {
        emit({
          type: EventType.TOOL_CALL_START,
          toolCallId: event.callId,
          toolCallName: event.name,
        });
        emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: event.callId, delta: event.args });
        emit({ type: EventType.TOOL_CALL_END, toolCallId: event.callId });
        // The client runs its own tools: this run ends here and the next one brings the result.
        if (clientToolNames.has(event.name)) {
          finish({ type: "success", pendingToolCallIds: [event.callId] });
        }
      } else if (event.type === "tool_result" && ours) {
        emit({
          type: EventType.TOOL_CALL_RESULT,
          messageId: randomUUID(),
          toolCallId: event.callId,
          content: event.content,
          role: "tool",
        });
      } else if (event.type === "approval_request" && ours) {
        waitingRuns.set(event.request.id, { meetingId, runId: event.runId });
        finish({
          type: "interrupt",
          interrupts: [
            {
              id: event.request.id,
              reason: "approval",
              message: event.request.summary,
              toolCallId: event.request.id,
              responseSchema: {
                type: "object",
                properties: { approved: { type: "boolean" } },
                required: ["approved"],
              },
            },
          ],
        });
      } else if (
        event.type === "reply" &&
        (mine(event.command) || (target.followRunId && event.command?.intent === "agent"))
      ) {
        // Built-in commands answer without an agent run; agent runs already streamed their text.
        if (!messageId) text(event.text);
        finish();
      } else if (event.type === "run_error" && ours) {
        emit({ type: EventType.RUN_ERROR, message: event.message });
        finished = true;
        unsubscribe();
        resolve();
      } else if (event.type === "closed") {
        finish();
      }
    });
    run.closed.then(() => {
      finished = true;
      unsubscribe();
      resolve();
    });

    if (target.text) {
      const tools = frontendTools(input.tools);
      manager
        .command(meetingId, target.text, {
          from: "panel",
          commandId,
          ...(tools.length ? { tools } : {}),
        })
        .catch((error: unknown) => {
          emit({ type: EventType.RUN_ERROR, message: (error as Error).message });
          finished = true;
          unsubscribe();
          resolve();
        });
    }
  });
}

/** Follows a meeting until it ends (or the client leaves). */
async function streamSubscription(
  manager: MeetingManager,
  meetingId: string,
  run: AguiRun,
): Promise<void> {
  const { emit, input } = run;
  const live = manager.getLive(meetingId);
  const record = manager.get(meetingId);
  if (!record) return;

  emit({ type: EventType.STATE_SNAPSHOT, snapshot: record.state });
  emit(
    custom("om.meeting", {
      id: record.id,
      title: record.title,
      url: record.url,
      status: record.status,
      startedAt: record.startedAt,
      costUsd: record.costUsd,
    }),
  );
  const segments = live ? live.session.pipeline.segments : manager.segments(meetingId);
  for (const segment of segments) emit(custom("om.transcript", segment));
  if (!live) {
    if (record.minutes) emit(custom("om.minutes", { markdown: record.minutes }));
    emit({ type: EventType.RUN_FINISHED, threadId: meetingId, runId: input.runId });
    return;
  }

  const agentText = new Map<string, string>();
  await new Promise<void>((resolve) => {
    const unsubscribe = manager.subscribe(meetingId, (event) => {
      switch (event.type) {
        case "transcript":
          emit(custom("om.transcript", event.segment));
          break;
        case "participant":
          emit(
            custom("om.participant", {
              action: event.action,
              participant: event.participant,
              atMs: event.atMs,
            }),
          );
          break;
        case "chat":
          emit(custom("om.chat", event.message));
          break;
        case "state":
          emit({ type: EventType.STATE_DELTA, delta: event.patch });
          break;
        case "status":
          emit(custom("om.status", { status: event.status, reason: event.reason }));
          break;
        case "command":
          emit(custom("om.command", event.command));
          break;
        case "run_started":
          agentText.set(event.runId, "");
          emit({ type: EventType.STEP_STARTED, stepName: `agent:${event.runId}` });
          break;
        case "agent_text":
          agentText.set(event.runId, (agentText.get(event.runId) ?? "") + event.delta);
          break;
        case "tool_call":
          emit({
            type: EventType.TOOL_CALL_START,
            toolCallId: event.callId,
            toolCallName: event.name,
          });
          emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: event.callId, delta: event.args });
          emit({ type: EventType.TOOL_CALL_END, toolCallId: event.callId });
          break;
        case "tool_result":
          emit({
            type: EventType.TOOL_CALL_RESULT,
            messageId: randomUUID(),
            toolCallId: event.callId,
            content: event.content,
            role: "tool",
          });
          break;
        case "run_finished":
        case "run_error": {
          // The panel gets the full answer; the call chat got the short one.
          const full = agentText.get(event.runId);
          agentText.delete(event.runId);
          emit({ type: EventType.STEP_FINISHED, stepName: `agent:${event.runId}` });
          if (full) emitMessage(emit, full, { runId: event.runId });
          break;
        }
        case "reply":
          if (event.command?.intent !== "agent")
            emitMessage(emit, event.text, { command: event.command });
          break;
        case "approval_request":
          emit(custom("om.approval", { runId: event.runId, ...event.request }));
          break;
        case "approval_resolved":
          emit(custom("om.approval_resolved", event));
          break;
        case "usage":
          emit(
            custom("om.usage", {
              tier: event.tier,
              model: event.model,
              purpose: event.purpose,
              usage: event.usage,
            }),
          );
          break;
        case "cost":
          emit(custom("om.cost", { totalUsd: event.totalUsd }));
          break;
        case "latency":
          emit(custom("om.latency", { ms: event.ms }));
          break;
        case "minutes":
          emit(custom("om.minutes", { markdown: event.markdown }));
          break;
        case "warning":
          emit(custom("om.warning", { message: event.message }));
          break;
        case "closed":
          emit(custom("om.status", { status: "left", reason: event.reason }));
          emit({ type: EventType.RUN_FINISHED, threadId: meetingId, runId: input.runId });
          unsubscribe();
          resolve();
          break;
      }
    });
    run.closed.then(() => {
      unsubscribe();
      resolve();
    });
  });
}

function emitMessage(emit: Emit, text: string, metadata: Record<string, unknown>): void {
  const messageId = randomUUID();
  emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant", metadata });
  emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text });
  emit({ type: EventType.TEXT_MESSAGE_END, messageId });
}
