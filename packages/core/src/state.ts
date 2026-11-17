import jsonpatch, { type Operation } from "fast-json-patch";
import { z } from "zod";

const id = z.string().min(1);
const sources = z.array(z.string()).default([]);

export const meetingStateSchema = z.object({
  title: z.string().optional(),
  participants: z.array(
    z.object({
      id,
      name: z.string(),
      email: z.string().optional(),
      external: z.boolean().optional(),
    }),
  ),
  topics: z.array(z.object({ id, title: z.string(), startedAt: z.number(), summary: z.string() })),
  decisions: z.array(
    z.object({
      id,
      text: z.string(),
      by: z.string().optional(),
      at: z.number(),
      sourceSegmentIds: sources,
    }),
  ),
  actionItems: z.array(
    z.object({
      id,
      text: z.string(),
      owner: z.string().optional(),
      due: z.string().optional(),
      status: z.enum(["open", "done"]),
      sourceSegmentIds: sources,
    }),
  ),
  openQuestions: z.array(
    z.object({ id, text: z.string(), at: z.number(), sourceSegmentIds: sources }),
  ),
  artifacts: z.array(
    z.object({
      id,
      type: z.enum(["doc", "board", "sheet", "timeline"]),
      url: z.string(),
      title: z.string().optional(),
      /** Changes on every edit, so clients know to fetch the content again. */
      updatedAt: z.string().optional(),
    }),
  ),
  rollingSummary: z.string(),
});

export type MeetingState = z.infer<typeof meetingStateSchema>;
export type StatePatch = Operation[];

export function emptyState(title?: string): MeetingState {
  return {
    ...(title ? { title } : {}),
    participants: [],
    topics: [],
    decisions: [],
    actionItems: [],
    openQuestions: [],
    artifacts: [],
    rollingSummary: "",
  };
}

const patchOpSchema = z.object({
  op: z.enum(["add", "replace", "remove"]),
  path: z.string().startsWith("/"),
  value: z.unknown().optional(),
});
export const llmPatchSchema = z.object({ patch: z.array(patchOpSchema) });

/** The only parts of the state a model may edit. Participants and artifacts belong to the system. */
const MODEL_EDITABLE = /^\/(title|rollingSummary|topics|decisions|actionItems|openQuestions)(\/|$)/;

const LISTS = [
  { key: "topics", prefix: "top" },
  { key: "decisions", prefix: "dec" },
  { key: "actionItems", prefix: "act" },
  { key: "openQuestions", prefix: "q" },
] as const;

type Draft = Record<string, unknown>;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

function nextCounter(items: { id: string }[], prefix: string): number {
  let max = 0;
  for (const item of items) {
    const match = new RegExp(`^${prefix}-(\\d+)$`).exec(item.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

export type PatchContext = {
  /** Meeting time used for `at` / `startedAt` of new entries. */
  nowMs: number;
  /** Segment ids a model is allowed to cite. Unknown ids are dropped. */
  knownSegmentIds: ReadonlySet<string>;
};

export type PatchOutcome = {
  state: MeetingState;
  /** Exact RFC 6902 diff between the previous and the new state. Safe to send to clients. */
  patch: StatePatch;
  /** Operations that were rejected, with the reason. */
  rejected: string[];
};

/**
 * Applies a model-written patch defensively. Each operation runs on its own (a bad one does not
 * sink the rest), system-owned fields are restored, new entries get ids and timestamps, and
 * citations are limited to segments that exist. The returned patch is recomputed from the two
 * states, so clients replaying it always land on exactly the server's state.
 */
export function applyModelPatch(
  prev: MeetingState,
  ops: unknown,
  context: PatchContext,
): PatchOutcome {
  const rejected: string[] = [];
  const parsed = z.array(patchOpSchema).safeParse(ops);
  if (!parsed.success)
    return { state: prev, patch: [], rejected: ["patch is not a list of operations"] };

  let draft = structuredClone(prev) as Draft;
  for (const op of parsed.data) {
    if (!MODEL_EDITABLE.test(op.path)) {
      rejected.push(`${op.op} ${op.path}: path is not editable`);
      continue;
    }
    try {
      draft = jsonpatch.applyOperation(draft, op as Operation, true, false).newDocument as Draft;
    } catch (error) {
      rejected.push(`${op.op} ${op.path}: ${(error as Error).name}`);
    }
  }

  const state = normalize(draft, prev, context);
  return { state, patch: jsonpatch.compare(prev, state), rejected };
}

function normalize(draft: Draft, prev: MeetingState, context: PatchContext): MeetingState {
  const next: MeetingState = {
    ...prev,
    rollingSummary: text(draft.rollingSummary) ?? prev.rollingSummary,
  };
  const title = text(draft.title);
  if (title) next.title = title;

  for (const { key, prefix } of LISTS) {
    const previous = new Map((prev[key] as { id: string }[]).map((item) => [item.id, item]));
    const seen = new Set<string>();
    let counter = nextCounter(prev[key], prefix);
    const items: unknown[] = [];

    for (const raw of Array.isArray(draft[key]) ? (draft[key] as unknown[]) : []) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Draft;
      const body = text(item.text) ?? text(item.title);
      if (!body) continue;

      const existing =
        typeof item.id === "string" && !seen.has(item.id) ? previous.get(item.id) : undefined;
      const itemId = existing ? existing.id : `${prefix}-${counter++}`;
      seen.add(itemId);
      const cited = Array.isArray(item.sourceSegmentIds)
        ? item.sourceSegmentIds.filter(
            (s): s is string => typeof s === "string" && context.knownSegmentIds.has(s),
          )
        : [];
      const at = typeof item.at === "number" ? item.at : context.nowMs;

      if (key === "topics") {
        items.push({
          id: itemId,
          title: body,
          startedAt: typeof item.startedAt === "number" ? item.startedAt : context.nowMs,
          summary: text(item.summary) ?? "",
        });
      } else if (key === "decisions") {
        const by = text(item.by);
        items.push({ id: itemId, text: body, ...(by ? { by } : {}), at, sourceSegmentIds: cited });
      } else if (key === "actionItems") {
        const owner = text(item.owner);
        const due = text(item.due);
        items.push({
          id: itemId,
          text: body,
          ...(owner ? { owner } : {}),
          ...(due ? { due } : {}),
          status: item.status === "done" ? "done" : "open",
          sourceSegmentIds: cited,
        });
      } else {
        items.push({ id: itemId, text: body, at, sourceSegmentIds: cited });
      }
    }
    (next as Draft)[key] = items;
  }
  return meetingStateSchema.parse(next);
}

/** Applies a system-authored change (participants, artifacts) and returns the diff. */
export function updateState(
  prev: MeetingState,
  mutate: (draft: MeetingState) => void,
): { state: MeetingState; patch: StatePatch } {
  const state = structuredClone(prev);
  mutate(state);
  return { state, patch: jsonpatch.compare(prev, state) };
}

/** Replays a patch the way a client would. Used by tests and by AG-UI consumers. */
export function applyPatch(state: MeetingState, patch: StatePatch): MeetingState {
  return jsonpatch.applyPatch(structuredClone(state), patch, false, true).newDocument;
}
