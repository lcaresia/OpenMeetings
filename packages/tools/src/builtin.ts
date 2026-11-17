import { randomUUID } from "node:crypto";
import { type ArtifactContent, artifactUrl } from "@open-meetings/core";
import { z } from "zod";
import { defineTool, type Tool, type ToolContext, type ToolResult } from "./types";

const id = z
  .string()
  .optional()
  .describe(
    "Id of an artifact you created earlier, to replace its content. Omit to create a new one.",
  );
const title = z.string().min(1).describe("Short title shown on the panel tab.");

/** Saves (or replaces) an artifact and lists it in the meeting state, so every client sees it. */
async function saveArtifact(
  context: ToolContext,
  args: { id?: string | undefined; title: string },
  content: ArtifactContent,
): Promise<ToolResult> {
  const { session, artifacts } = context;
  const existing = args.id ? await artifacts.get(args.id) : undefined;
  if (args.id && (!existing || existing.meetingId !== session.meeting.id)) {
    return { content: `No artifact with id ${args.id} in this meeting.`, isError: true };
  }
  if (existing && existing.content.type !== content.type) {
    return {
      content: `Artifact ${args.id} is a ${existing.content.type}, not a ${content.type}.`,
      isError: true,
    };
  }
  const now = new Date().toISOString();
  const artifact = {
    id: existing?.id ?? `${content.type}-${randomUUID().slice(0, 8)}`,
    meetingId: session.meeting.id,
    title: args.title,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    content,
  };
  await artifacts.save(artifact);
  session.addArtifact({
    id: artifact.id,
    type: content.type,
    url: artifactUrl(artifact.id),
    title: artifact.title,
    updatedAt: artifact.updatedAt,
  });
  const verb = existing ? "Updated" : "Created";
  return {
    content: `${verb} ${content.type} "${artifact.title}" (id ${artifact.id}). It is on the panel.`,
  };
}

const createDoc = defineTool({
  name: "create_doc",
  description:
    "Create or replace a document shown on the meeting panel. Use for minutes, plans, briefs, " +
    "any prose longer than a chat message. Content is Markdown.",
  schema: z.object({
    id,
    title,
    markdown: z.string().min(1).describe("Full document in Markdown."),
  }),
  run: (args, context) => saveArtifact(context, args, { type: "doc", markdown: args.markdown }),
});

const createSheet = defineTool({
  name: "create_sheet",
  description:
    "Create or replace an editable table on the meeting panel (exports to CSV/XLSX). Use for " +
    "lists with several attributes: costs, tasks with owner and date, comparisons.",
  schema: z.object({
    id,
    title,
    columns: z.array(z.string()).min(1).describe("Column headers."),
    rows: z
      .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
      .describe("One array per row, with one value per column, in column order."),
  }),
  run: (args, context) => {
    const width = args.columns.length;
    const rows = args.rows.map((row) => [...row, ...Array(width).fill(null)].slice(0, width));
    return saveArtifact(context, args, { type: "sheet", columns: args.columns, rows });
  },
});

const createBoard = defineTool({
  name: "create_board",
  description:
    "Create or replace a board on the meeting panel: columns of cards, like a kanban or a " +
    "grouping of ideas. Use for work split by status, by person or by theme.",
  schema: z.object({
    id,
    title,
    columns: z
      .array(
        z.object({
          title: z.string().describe("Column name, e.g. a status, a person or a theme."),
          cards: z.array(z.string()).describe("Short card texts."),
        }),
      )
      .min(1),
  }),
  run: (args, context) => saveArtifact(context, args, { type: "board", columns: args.columns }),
});

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");

const createTimeline = defineTool({
  name: "create_timeline",
  description:
    "Create or replace a simple Gantt timeline on the meeting panel. Use for a schedule built " +
    "from the action items that have a due date, or any plan with dated steps.",
  schema: z.object({
    id,
    title,
    tasks: z
      .array(
        z.object({
          name: z.string(),
          owner: z.string().optional(),
          start: date.describe(
            "First day of the task, YYYY-MM-DD. Use today when it was not said.",
          ),
          end: date.describe("Due date, YYYY-MM-DD."),
        }),
      )
      .min(1),
  }),
  run: (args, context) => {
    // A task that ends before it starts is a model slip, not a reason to fail the request.
    const tasks = args.tasks.map((task) =>
      task.end < task.start ? { ...task, start: task.end } : task,
    );
    return saveArtifact(context, args, { type: "timeline", tasks });
  },
});

const searchPastMeetings = defineTool({
  name: "search_past_meetings",
  description:
    "Search the transcripts and notes of earlier meetings by meaning. Use when someone asks " +
    "what was said, decided or left pending in a previous meeting.",
  schema: z.object({
    query: z.string().min(1).describe("What to look for, in natural language."),
    limit: z.number().int().min(1).max(20).default(5),
  }),
  run: async (args, context) => {
    if (!context.search) {
      return {
        content: "Search over earlier meetings is not configured (no embeddings engine).",
        isError: true,
      };
    }
    const hits = await context.search(args.query, args.limit);
    if (hits.length === 0) return { content: "Nothing relevant found in earlier meetings." };
    return {
      content: hits
        .map((hit) => `[${hit.date ?? "?"}] ${hit.meetingTitle ?? hit.meetingId}: ${hit.text}`)
        .join("\n"),
    };
  },
});

const MAX_FETCH_CHARS = 8000;

const webFetch = defineTool({
  name: "web_fetch",
  description:
    "Fetch a public web page and return its text. Use only when someone gives or asks about a URL.",
  schema: z.object({ url: z.url().describe("http(s) URL to fetch.") }),
  run: async (args, context) => {
    if (!/^https?:\/\//.test(args.url))
      return { content: "Only http(s) URLs can be fetched.", isError: true };
    const res = await (context.fetch ?? fetch)(args.url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { content: `The page answered HTTP ${res.status}.`, isError: true };
    const text = (await res.text())
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { content: text.slice(0, MAX_FETCH_CHARS) };
  },
});

/** The tools every meeting has. `web_fetch` is opt-out and never present in local-only mode. */
export function builtinTools(options: { webFetch: boolean }): Tool[] {
  const tools = [createDoc, createSheet, createBoard, createTimeline, searchPastMeetings];
  return options.webFetch ? [...tools, webFetch] : tools;
}
