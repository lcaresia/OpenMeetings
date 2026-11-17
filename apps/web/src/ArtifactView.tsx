import { marked } from "marked";
import { useEffect, useMemo, useState } from "react";
import { api, withToken } from "./api";
import { useI18n } from "./i18n";
import type { Artifact, ArtifactRef, Cell } from "./types";
import { Button } from "./ui";

/** Loads an artifact and fetches it again whenever the agent (or someone) edits it. */
export function useArtifact(ref: ArtifactRef) {
  const [artifact, setArtifact] = useState<Artifact>();
  const [error, setError] = useState<string>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: updatedAt is the refetch signal
  useEffect(() => {
    api<Artifact>(`/api/artifacts/${ref.id}`).then(setArtifact, (e: Error) => setError(e.message));
  }, [ref.id, ref.updatedAt]);
  return { artifact, error, setArtifact };
}

function Exports({ artifact }: { artifact: Artifact }) {
  const { t } = useI18n();
  const link = (format: string) =>
    withToken(`/api/artifacts/${artifact.id}/export?format=${format}`);
  const formats: [string, string][] =
    artifact.content.type === "doc"
      ? [
          ["md", t.exportMd],
          ["docx", t.exportDocx],
        ]
      : [
          ["csv", t.exportCsv],
          ["xlsx", t.exportXlsx],
          ...(artifact.content.type === "board"
            ? ([["excalidraw", t.exportExcalidraw]] as [string, string][])
            : []),
        ];
  return (
    <div className="flex flex-wrap gap-2">
      {formats.map(([format, label]) => (
        <a
          key={format}
          href={link(format)}
          className="rounded-lg border border-stone-300 px-2.5 py-1 text-xs hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800"
        >
          {label}
        </a>
      ))}
      {artifact.content.type === "doc" ? (
        <a
          href={`${link("html")}#print`}
          target="_blank"
          rel="noreferrer"
          className="rounded-lg border border-stone-300 px-2.5 py-1 text-xs hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800"
        >
          {t.exportPdf}
        </a>
      ) : null}
    </div>
  );
}

function DocView({ markdown }: { markdown: string }) {
  // Markdown comes from the meeting's own model; raw HTML in it is not rendered.
  const html = useMemo(
    () => marked.parse(markdown.replace(/</g, "&lt;"), { async: false }),
    [markdown],
  );
  return (
    <div
      className="prose-doc max-w-none text-sm"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML is escaped before Markdown parsing
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function SheetView({
  artifact,
  onSaved,
}: {
  artifact: Artifact & { content: { type: "sheet" } };
  onSaved: (a: Artifact) => void;
}) {
  const { t } = useI18n();
  const [rows, setRows] = useState<Cell[][]>(artifact.content.rows);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  useEffect(() => setRows(artifact.content.rows), [artifact.content.rows]);
  const columns = artifact.content.columns;
  const dirty = JSON.stringify(rows) !== JSON.stringify(artifact.content.rows);

  const edit = (r: number, c: number, raw: string) => {
    const value: Cell =
      raw !== "" && Number.isFinite(Number(raw)) && /^-?[\d.]+$/.test(raw) ? Number(raw) : raw;
    setRows((current) =>
      current.map((row, i) => (i === r ? row.map((cell, j) => (j === c ? value : cell)) : row)),
    );
    setState("idle");
  };
  const save = async () => {
    setState("saving");
    const saved = await api<Artifact>(`/api/artifacts/${artifact.id}`, {
      method: "PUT",
      body: JSON.stringify({ content: { type: "sheet", columns, rows } }),
    });
    onSaved(saved);
    setState("saved");
  };

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column}
                  className="border border-stone-200 bg-stone-50 px-2 py-1.5 text-left font-medium dark:border-stone-700 dark:bg-stone-800"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
              <tr key={r}>
                {columns.map((column, c) => (
                  <td key={column} className="border border-stone-200 p-0 dark:border-stone-700">
                    <input
                      className="w-full bg-transparent px-2 py-1.5 outline-none focus:bg-brand-50 dark:focus:bg-stone-800"
                      value={row[c] === null || row[c] === undefined ? "" : String(row[c])}
                      onChange={(event) => edit(r, c, event.target.value)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex gap-2">
        <Button
          variant="ghost"
          onClick={() => setRows((current) => [...current, columns.map(() => null)])}
        >
          {t.addRow}
        </Button>
        <Button disabled={!dirty || state === "saving"} onClick={() => void save()}>
          {state === "saved" && !dirty ? t.saved : t.save}
        </Button>
      </div>
    </div>
  );
}

function BoardView({ columns }: { columns: { title: string; cards: string[] }[] }) {
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {columns.map((column) => (
        <div
          key={column.title}
          className="w-64 shrink-0 rounded-lg bg-stone-100 p-2 dark:bg-stone-800"
        >
          <h3 className="mb-2 px-1 text-sm font-semibold">
            {column.title} <span className="font-normal text-stone-500">{column.cards.length}</span>
          </h3>
          <div className="space-y-2">
            {column.cards.map((card, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: cards can repeat
              <div key={i} className="rounded-md bg-white p-2 text-sm shadow-sm dark:bg-stone-900">
                {card}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const DAY = 86_400_000;

function TimelineView({
  tasks,
}: {
  tasks: { name: string; owner?: string; start: string; end: string }[];
}) {
  const { lang } = useI18n();
  if (tasks.length === 0) return null;
  const time = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  const first = Math.min(...tasks.map((task) => time(task.start)));
  const last = Math.max(...tasks.map((task) => time(task.end))) + DAY;
  const span = Math.max(DAY, last - first);
  const days = Math.round(span / DAY);
  const ticks = Array.from(
    { length: Math.min(days, 14) + 1 },
    (_, i) => first + Math.round((i * days) / Math.min(days, 14)) * DAY,
  );
  const label = (ms: number) =>
    new Date(ms).toLocaleDateString(lang, { day: "2-digit", month: "short", timeZone: "UTC" });

  return (
    <div className="space-y-1.5 text-sm">
      <div className="relative ml-48 h-5 text-[10px] text-stone-500">
        {ticks.map((tick) => (
          <span
            key={tick}
            className="absolute -translate-x-1/2"
            style={{ left: `${((tick - first) / span) * 100}%` }}
          >
            {label(tick)}
          </span>
        ))}
      </div>
      {tasks.map((task, i) => {
        const left = ((time(task.start) - first) / span) * 100;
        const width = Math.max(2, ((time(task.end) + DAY - time(task.start)) / span) * 100);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: tasks can share a name
          <div key={i} className="flex items-center">
            <div className="w-48 shrink-0 truncate pr-2" title={task.name}>
              {task.name}
              {task.owner ? <span className="text-stone-500"> · {task.owner}</span> : null}
            </div>
            <div className="relative h-6 flex-1 rounded bg-stone-100 dark:bg-stone-800">
              <div
                className="absolute top-1 h-4 rounded bg-brand-600"
                style={{ left: `${left}%`, width: `${width}%` }}
                title={`${task.start} → ${task.end}`}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ArtifactView({ refInfo }: { refInfo: ArtifactRef }) {
  const { artifact, error, setArtifact } = useArtifact(refInfo);
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!artifact) return <p className="text-sm text-stone-500">...</p>;
  const { content } = artifact;
  return (
    <div className="space-y-4">
      <Exports artifact={artifact} />
      {content.type === "doc" ? <DocView markdown={content.markdown} /> : null}
      {content.type === "sheet" ? (
        <SheetView
          artifact={artifact as Artifact & { content: { type: "sheet" } }}
          onSaved={setArtifact}
        />
      ) : null}
      {content.type === "board" ? <BoardView columns={content.columns} /> : null}
      {content.type === "timeline" ? <TimelineView tasks={content.tasks} /> : null}
    </div>
  );
}

export { DocView };
