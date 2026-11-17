// Shapes the server sends. Kept here (not imported from core) so the panel builds on its own.

export type Segment = {
  id: string;
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
  partial?: boolean;
  source: string;
};

export type Decision = {
  id: string;
  text: string;
  by?: string;
  at: number;
  sourceSegmentIds: string[];
};
export type ActionItem = {
  id: string;
  text: string;
  owner?: string;
  due?: string;
  status: "open" | "done";
  sourceSegmentIds: string[];
};
export type OpenQuestion = { id: string; text: string; at: number; sourceSegmentIds: string[] };
export type ArtifactRef = {
  id: string;
  type: "doc" | "board" | "sheet" | "timeline";
  url: string;
  title?: string;
  updatedAt?: string;
};

export type MeetingState = {
  title?: string;
  participants: { id: string; name: string; external?: boolean }[];
  topics: { id: string; title: string; startedAt: number; summary: string }[];
  decisions: Decision[];
  actionItems: ActionItem[];
  openQuestions: OpenQuestion[];
  artifacts: ArtifactRef[];
  rollingSummary: string;
};

export type Cell = string | number | boolean | null;
export type ArtifactContent =
  | { type: "doc"; markdown: string }
  | { type: "sheet"; columns: string[]; rows: Cell[][] }
  | { type: "board"; columns: { title: string; cards: string[] }[] }
  | { type: "timeline"; tasks: { name: string; owner?: string; start: string; end: string }[] };

export type Artifact = {
  id: string;
  meetingId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  content: ArtifactContent;
};

export type MeetingSummary = {
  id: string;
  platform: string;
  url?: string;
  title?: string;
  status: "joining" | "live" | "ended" | "failed";
  startedAt: string;
  endedAt?: string;
  endReason?: string;
  state: MeetingState;
  minutes?: string;
  costUsd: number;
};

export type SearchHit = {
  meetingId: string;
  meetingTitle?: string;
  date?: string;
  text: string;
  score: number;
};

export type Approval = { id: string; runId: string; tool: string; summary: string };

export const emptyState = (): MeetingState => ({
  participants: [],
  topics: [],
  decisions: [],
  actionItems: [],
  openQuestions: [],
  artifacts: [],
  rollingSummary: "",
});
