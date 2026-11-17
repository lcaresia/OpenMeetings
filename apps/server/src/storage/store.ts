import type { ArtifactStore, MeetingState, TranscriptSegment } from "@open-meetings/core";

export type MeetingStatus = "joining" | "live" | "ended" | "failed";

export type MeetingRecord = {
  id: string;
  platform: string;
  url?: string;
  title?: string;
  /**
   * Identifies a recurring meeting: the same link (or, without one, the same title). Used to
   * carry pending items from one occurrence to the next.
   */
  seriesKey?: string;
  status: MeetingStatus;
  startedAt: string;
  endedAt?: string;
  endReason?: string;
  state: MeetingState;
  /** Final minutes in Markdown, written when the meeting ends. */
  minutes?: string;
  costUsd: number;
};

export type UsageRecord = {
  meetingId: string;
  tier: "fast" | "smart";
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type Chunk = {
  kind: "transcript" | "minutes" | "decision" | "action";
  text: string;
  embedding: number[];
};

export type ChunkHit = {
  meetingId: string;
  meetingTitle?: string;
  startedAt: string;
  kind: Chunk["kind"];
  text: string;
  score: number;
};

/** Everything the server persists. SQLite implements it; another database can too. */
export interface MeetingStore {
  readonly artifacts: ArtifactStore;
  createMeeting(record: MeetingRecord): void;
  updateMeeting(id: string, patch: Partial<Omit<MeetingRecord, "id">>): void;
  getMeeting(id: string): MeetingRecord | undefined;
  listMeetings(options?: { limit?: number; text?: string }): MeetingRecord[];
  /** The most recent ended meeting of a series, other than `excludeId`. */
  lastInSeries(seriesKey: string, excludeId: string): MeetingRecord | undefined;
  /** Removes a meeting and everything attached to it. Returns false when it did not exist. */
  deleteMeeting(id: string): boolean;
  /** Deletes meetings that started before `before`. Returns how many were removed. */
  purgeBefore(before: Date): number;
  upsertSegment(meetingId: string, segment: TranscriptSegment): void;
  listSegments(meetingId: string): TranscriptSegment[];
  recordUsage(usage: UsageRecord): void;
  addChunks(meetingId: string, chunks: Chunk[]): void;
  searchChunks(
    embedding: number[],
    limit: number,
    options?: { excludeMeetingId?: string },
  ): ChunkHit[];
  close(): void;
}
