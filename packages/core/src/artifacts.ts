import { z } from "zod";

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");

export const artifactContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("doc"), markdown: z.string() }),
  z.object({
    type: z.literal("sheet"),
    columns: z.array(z.string()).min(1),
    rows: z.array(z.array(cell)),
  }),
  z.object({
    type: z.literal("board"),
    columns: z.array(z.object({ title: z.string(), cards: z.array(z.string()) })).min(1),
  }),
  z.object({
    type: z.literal("timeline"),
    tasks: z.array(
      z.object({ name: z.string(), owner: z.string().optional(), start: isoDate, end: isoDate }),
    ),
  }),
]);

export type ArtifactContent = z.infer<typeof artifactContentSchema>;
export type ArtifactType = ArtifactContent["type"];

/** Something the agent produced during a meeting: a document, a sheet, a board, a timeline. */
export type Artifact = {
  id: string;
  meetingId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  content: ArtifactContent;
};

export interface ArtifactStore {
  save(artifact: Artifact): Promise<void>;
  get(id: string): Promise<Artifact | undefined>;
  list(meetingId: string): Promise<Artifact[]>;
}

export class MemoryArtifactStore implements ArtifactStore {
  private readonly items = new Map<string, Artifact>();

  async save(artifact: Artifact): Promise<void> {
    this.items.set(artifact.id, structuredClone(artifact));
  }

  async get(id: string): Promise<Artifact | undefined> {
    const found = this.items.get(id);
    return found ? structuredClone(found) : undefined;
  }

  async list(meetingId: string): Promise<Artifact[]> {
    return [...this.items.values()].filter((artifact) => artifact.meetingId === meetingId);
  }
}

/** Where the panel shows an artifact. */
export const artifactUrl = (id: string) => `/artifacts/${id}`;

const csvCell = (value: unknown): string => {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n;]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** Plain-text export of any artifact: Markdown for docs, CSV for the tabular kinds. */
export function exportArtifact(artifact: Artifact): {
  filename: string;
  mime: string;
  body: string;
} {
  const slug =
    artifact.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "artifact";
  const { content } = artifact;
  if (content.type === "doc") {
    return { filename: `${slug}.md`, mime: "text/markdown", body: content.markdown };
  }
  const table: unknown[][] =
    content.type === "sheet"
      ? [content.columns, ...content.rows]
      : content.type === "board"
        ? [
            ["column", "card"],
            ...content.columns.flatMap((c) => c.cards.map((card) => [c.title, card])),
          ]
        : [
            ["task", "owner", "start", "end"],
            ...content.tasks.map((t) => [t.name, t.owner, t.start, t.end]),
          ];
  const body = table.map((row) => row.map(csvCell).join(",")).join("\n");
  return { filename: `${slug}.csv`, mime: "text/csv", body };
}
