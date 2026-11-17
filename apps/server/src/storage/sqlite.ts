import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Artifact, ArtifactStore, MeetingState, TranscriptSegment } from "@open-meetings/core";
import type { Chunk, ChunkHit, MeetingRecord, MeetingStore, UsageRecord } from "./store";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  url TEXT,
  title TEXT,
  series_key TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  state TEXT NOT NULL,
  minutes TEXT,
  cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS meetings_series ON meetings (series_key, started_at);
CREATE TABLE IF NOT EXISTS segments (
  meeting_id TEXT NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  speaker TEXT NOT NULL,
  text TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (meeting_id, id)
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  meeting_id TEXT NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  tier TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB NOT NULL
);
`;

type Row = Record<string, unknown>;

function toRecord(row: Row): MeetingRecord {
  const optional = (key: string) =>
    row[key] === null || row[key] === undefined ? undefined : String(row[key]);
  const record: MeetingRecord = {
    id: String(row.id),
    platform: String(row.platform),
    status: row.status as MeetingRecord["status"],
    startedAt: String(row.started_at),
    state: JSON.parse(String(row.state)) as MeetingState,
    costUsd: Number(row.cost_usd),
  };
  for (const [key, column] of [
    ["url", "url"],
    ["title", "title"],
    ["seriesKey", "series_key"],
    ["endedAt", "ended_at"],
    ["endReason", "end_reason"],
    ["minutes", "minutes"],
  ] as const) {
    const value = optional(column);
    if (value !== undefined) record[key] = value;
  }
  return record;
}

/** Unit vectors, so similarity is a plain dot product. */
function normalize(vector: number[]): Float32Array {
  const out = Float32Array.from(vector);
  let norm = 0;
  for (const value of out) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] ?? 0) / norm;
  return out;
}

function fromBlob(blob: Uint8Array): Float32Array {
  // Copy: a SQLite blob is not guaranteed to be 4-byte aligned.
  const copy = new Uint8Array(blob);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

/** Loads node:sqlite without its one-time "experimental" warning on stderr. */
async function loadSqlite(): Promise<typeof import("node:sqlite")> {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning).includes("SQLite")) return;
    (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return await import("node:sqlite");
  } finally {
    process.emitWarning = original;
  }
}

/**
 * SQLite storage through Node's built-in driver: no native module to compile. Semantic search
 * is a dot product over normalized vectors in memory, which is fast for the tens of thousands
 * of chunks one team accumulates (ADR 0004).
 */
export async function openSqliteStore(path: string): Promise<MeetingStore> {
  const { DatabaseSync } = await loadSqlite();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db: DatabaseSync = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);

  const artifacts: ArtifactStore = {
    async save(artifact: Artifact) {
      db.prepare(
        `INSERT INTO artifacts (id, meeting_id, title, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET title = excluded.title, content = excluded.content,
           updated_at = excluded.updated_at`,
      ).run(
        artifact.id,
        artifact.meetingId,
        artifact.title,
        JSON.stringify(artifact.content),
        artifact.createdAt,
        artifact.updatedAt,
      );
    },
    async get(id: string) {
      const row = db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as Row | undefined;
      return row ? toArtifact(row) : undefined;
    },
    async list(meetingId: string) {
      const rows = db
        .prepare("SELECT * FROM artifacts WHERE meeting_id = ? ORDER BY created_at")
        .all(meetingId) as Row[];
      return rows.map(toArtifact);
    },
  };

  function toArtifact(row: Row): Artifact {
    return {
      id: String(row.id),
      meetingId: String(row.meeting_id),
      title: String(row.title),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      content: JSON.parse(String(row.content)) as Artifact["content"],
    };
  }

  const COLUMNS: Record<string, string> = {
    platform: "platform",
    url: "url",
    title: "title",
    seriesKey: "series_key",
    status: "status",
    startedAt: "started_at",
    endedAt: "ended_at",
    endReason: "end_reason",
    state: "state",
    minutes: "minutes",
    costUsd: "cost_usd",
  };
  const value = (key: string, input: unknown) =>
    key === "state" ? JSON.stringify(input) : (input ?? null);

  return {
    artifacts,

    createMeeting(record) {
      db.prepare(
        `INSERT INTO meetings (id, platform, url, title, series_key, status, started_at, ended_at,
           end_reason, state, minutes, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.platform,
        record.url ?? null,
        record.title ?? null,
        record.seriesKey ?? null,
        record.status,
        record.startedAt,
        record.endedAt ?? null,
        record.endReason ?? null,
        JSON.stringify(record.state),
        record.minutes ?? null,
        record.costUsd,
      );
    },

    updateMeeting(id, patch) {
      const entries = Object.entries(patch).filter(([key]) => key in COLUMNS);
      if (entries.length === 0) return;
      const sets = entries.map(([key]) => `${COLUMNS[key]} = ?`).join(", ");
      const params = entries.map(([key, input]) => value(key, input)) as (string | number | null)[];
      db.prepare(`UPDATE meetings SET ${sets} WHERE id = ?`).run(...params, id);
    },

    getMeeting(id) {
      const row = db.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as Row | undefined;
      return row ? toRecord(row) : undefined;
    },

    listMeetings({ limit = 50, text } = {}) {
      const rows = text
        ? (db
            .prepare(
              `SELECT * FROM meetings WHERE title LIKE ? OR minutes LIKE ?
               ORDER BY started_at DESC LIMIT ?`,
            )
            .all(`%${text}%`, `%${text}%`, limit) as Row[])
        : (db
            .prepare("SELECT * FROM meetings ORDER BY started_at DESC LIMIT ?")
            .all(limit) as Row[]);
      return rows.map(toRecord);
    },

    lastInSeries(seriesKey, excludeId) {
      const row = db
        .prepare(
          `SELECT * FROM meetings WHERE series_key = ? AND id != ? AND status = 'ended'
           ORDER BY started_at DESC LIMIT 1`,
        )
        .get(seriesKey, excludeId) as Row | undefined;
      return row ? toRecord(row) : undefined;
    },

    deleteMeeting(id) {
      const result = db.prepare("DELETE FROM meetings WHERE id = ?").run(id);
      return Number(result.changes) > 0;
    },

    purgeBefore(before) {
      const result = db
        .prepare("DELETE FROM meetings WHERE started_at < ? AND status != 'live'")
        .run(before.toISOString());
      return Number(result.changes);
    },

    upsertSegment(meetingId, segment) {
      db.prepare(
        `INSERT INTO segments (meeting_id, id, speaker, text, start_ms, end_ms, source)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (meeting_id, id) DO UPDATE SET speaker = excluded.speaker,
           text = excluded.text, end_ms = excluded.end_ms`,
      ).run(
        meetingId,
        segment.id,
        segment.speaker,
        segment.text,
        segment.startMs,
        segment.endMs,
        segment.source,
      );
    },

    listSegments(meetingId) {
      const rows = db
        .prepare("SELECT * FROM segments WHERE meeting_id = ? ORDER BY start_ms, rowid")
        .all(meetingId) as Row[];
      return rows.map(
        (row): TranscriptSegment => ({
          id: String(row.id),
          speaker: String(row.speaker),
          text: String(row.text),
          startMs: Number(row.start_ms),
          endMs: Number(row.end_ms),
          source: row.source as TranscriptSegment["source"],
        }),
      );
    },

    recordUsage(usage: UsageRecord) {
      db.prepare(
        `INSERT INTO usage (meeting_id, tier, model, purpose, input_tokens, output_tokens, cost_usd, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        usage.meetingId,
        usage.tier,
        usage.model,
        usage.purpose,
        usage.inputTokens,
        usage.outputTokens,
        usage.costUsd,
        new Date().toISOString(),
      );
      db.prepare("UPDATE meetings SET cost_usd = cost_usd + ? WHERE id = ?").run(
        usage.costUsd,
        usage.meetingId,
      );
    },

    addChunks(meetingId, chunks: Chunk[]) {
      const insert = db.prepare(
        "INSERT INTO chunks (meeting_id, kind, text, embedding) VALUES (?, ?, ?, ?)",
      );
      db.exec("BEGIN");
      try {
        for (const chunk of chunks) {
          const vector = normalize(chunk.embedding);
          insert.run(meetingId, chunk.kind, chunk.text, new Uint8Array(vector.buffer));
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    searchChunks(embedding, limit, { excludeMeetingId } = {}) {
      const query = normalize(embedding);
      const rows = db
        .prepare(
          `SELECT c.meeting_id, c.kind, c.text, c.embedding, m.title, m.started_at
           FROM chunks c JOIN meetings m ON m.id = c.meeting_id`,
        )
        .all() as Row[];
      const hits: ChunkHit[] = [];
      for (const row of rows) {
        if (excludeMeetingId && row.meeting_id === excludeMeetingId) continue;
        const vector = fromBlob(row.embedding as Uint8Array);
        if (vector.length !== query.length) continue; // embedded with another model
        let score = 0;
        for (let i = 0; i < query.length; i++) score += (query[i] ?? 0) * (vector[i] ?? 0);
        hits.push({
          meetingId: String(row.meeting_id),
          ...(row.title ? { meetingTitle: String(row.title) } : {}),
          startedAt: String(row.started_at),
          kind: row.kind as Chunk["kind"],
          text: String(row.text),
          score,
        });
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, limit);
    },

    close() {
      db.close();
    },
  };
}
