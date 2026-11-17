import { applyPatch, type Operation } from "fast-json-patch";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { type AguiEvent, aguiRun, UnauthorizedError } from "./api";
import { type Approval, emptyState, type MeetingState, type Segment } from "./types";

export type AgentMessage = { id: string; text: string; done: boolean };

export type MeetingView = {
  meeting?: { id: string; title?: string; url?: string; status: string; startedAt: string };
  state: MeetingState;
  segments: Segment[];
  messages: AgentMessage[];
  approvals: Approval[];
  costUsd: number;
  latencyMs?: number;
  status: string;
  minutes?: string;
  agentBusy: number;
  connected: boolean;
  error?: string;
  unauthorized?: boolean;
  activity: string[];
};

const initial: MeetingView = {
  state: emptyState(),
  segments: [],
  messages: [],
  approvals: [],
  costUsd: 0,
  status: "joining",
  agentBusy: 0,
  connected: false,
  activity: [],
};

type Action =
  | { kind: "event"; event: AguiEvent }
  | { kind: "reset" }
  | { kind: "connected"; value: boolean }
  | { kind: "error"; message: string; unauthorized?: boolean };

function upsertSegment(segments: Segment[], segment: Segment): Segment[] {
  const index = segments.findIndex((existing) => existing.id === segment.id);
  if (index === -1) return [...segments, segment];
  const next = segments.slice();
  next[index] = segment;
  return next;
}

/** Applies one AG-UI event to the view. This is the whole client-side protocol. */
export function reduce(view: MeetingView, action: Action): MeetingView {
  if (action.kind === "reset") return { ...initial };
  if (action.kind === "connected") return { ...view, connected: action.value };
  if (action.kind === "error") {
    return {
      ...view,
      error: action.message,
      ...(action.unauthorized ? { unauthorized: true } : {}),
    };
  }
  const event = action.event;
  switch (event.type) {
    case "STATE_SNAPSHOT":
      return { ...view, state: event.snapshot as MeetingState, segments: [], messages: [] };
    case "STATE_DELTA":
      return {
        ...view,
        state: applyPatch(structuredClone(view.state), event.delta as Operation[], false, false)
          .newDocument,
      };
    case "TEXT_MESSAGE_START":
      return {
        ...view,
        messages: [...view.messages, { id: String(event.messageId), text: "", done: false }],
      };
    case "TEXT_MESSAGE_CONTENT":
      return {
        ...view,
        messages: view.messages.map((m) =>
          m.id === event.messageId ? { ...m, text: m.text + String(event.delta) } : m,
        ),
      };
    case "TEXT_MESSAGE_END":
      return {
        ...view,
        messages: view.messages.map((m) => (m.id === event.messageId ? { ...m, done: true } : m)),
      };
    case "STEP_STARTED":
      return { ...view, agentBusy: view.agentBusy + 1 };
    case "STEP_FINISHED":
      return { ...view, agentBusy: Math.max(0, view.agentBusy - 1) };
    case "TOOL_CALL_START":
      return { ...view, activity: [...view.activity.slice(-19), String(event.toolCallName)] };
    case "RUN_ERROR":
      return { ...view, error: String(event.message) };
    case "CUSTOM":
      return reduceCustom(view, String(event.name), event.value as Record<string, unknown>);
    default:
      return view;
  }
}

function reduceCustom(
  view: MeetingView,
  name: string,
  value: Record<string, unknown>,
): MeetingView {
  switch (name) {
    case "om.meeting":
      return {
        ...view,
        meeting: value as MeetingView["meeting"] & object,
        status: String(value.status),
        costUsd: Number(value.costUsd ?? 0),
      };
    case "om.transcript":
      return { ...view, segments: upsertSegment(view.segments, value as unknown as Segment) };
    case "om.status":
      return { ...view, status: String(value.status) };
    case "om.cost":
      return { ...view, costUsd: Number(value.totalUsd) };
    case "om.latency":
      return { ...view, latencyMs: Number(value.ms) };
    case "om.minutes":
      return { ...view, minutes: String(value.markdown) };
    case "om.approval":
      return { ...view, approvals: [...view.approvals, value as unknown as Approval] };
    case "om.approval_resolved":
      return { ...view, approvals: view.approvals.filter((a) => a.id !== value.id) };
    case "om.participant":
      if (view.status === "joining") return { ...view, status: "live" };
      return view;
    default:
      return view;
  }
}

/** Follows a meeting over AG-UI, reconnecting while it is live. */
export function useMeeting(id: string) {
  const [view, dispatch] = useReducer(reduce, initial);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    const controller = new AbortController();
    let finished = false;
    const loop = async () => {
      while (live.current && !finished) {
        dispatch({ kind: "reset" });
        try {
          dispatch({ kind: "connected", value: true });
          await aguiRun(
            { threadId: id },
            (event) => {
              if (event.type === "RUN_FINISHED") finished = true;
              dispatch({ kind: "event", event });
            },
            controller.signal,
          );
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error instanceof UnauthorizedError) {
            dispatch({ kind: "error", message: "unauthorized", unauthorized: true });
            return;
          }
        }
        dispatch({ kind: "connected", value: false });
        if (!finished && live.current) await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    };
    void loop();
    return () => {
      live.current = false;
      controller.abort();
    };
  }, [id]);

  /** A command goes through its own AG-UI run; the answer arrives on the subscription. */
  const ask = useCallback(
    async (text: string) => {
      await aguiRun(
        { threadId: id, messages: [{ id: crypto.randomUUID(), role: "user", content: text }] },
        (event) => {
          if (event.type === "RUN_ERROR")
            dispatch({ kind: "error", message: String(event.message) });
        },
      );
    },
    [id],
  );

  const answer = useCallback(
    async (approvalId: string, approved: boolean) => {
      await aguiRun(
        {
          threadId: id,
          resume: [
            {
              interruptId: approvalId,
              status: approved ? "resolved" : "cancelled",
              payload: { approved },
            },
          ],
        },
        () => undefined,
      );
    },
    [id],
  );

  return { view, ask, answer };
}
