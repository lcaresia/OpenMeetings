import { type Fixture, FixtureSource } from "./fixture";
import type { LlmEngine } from "./llm";
import type { MeetingPipeline } from "./pipeline";
import {
  type AgentRunner,
  MeetingSession,
  type SessionEvent,
  type SessionOptions,
} from "./session";

export type ReplayResult = {
  session: MeetingSession;
  pipeline: MeetingPipeline;
  source: FixtureSource;
  events: SessionEvent[];
};

export const DEFAULT_SESSION_OPTIONS: SessionOptions = {
  agentName: "Open Meetings",
  displayName: "Open Meetings (assistente IA)",
  language: "pt-BR",
  summaryIntervalSec: 45,
  wakeWords: ["open meetings", "ei open", "hey open"],
  joinMessage:
    "Olá, sou o Open Meetings, assistente de IA. Estou transcrevendo esta reunião. Digite 'om sair' para eu sair.",
  externalGuests: "allow",
  internalDomains: [],
};

/** Runs a recorded meeting through the real session and pipeline, as fast as `speed` allows. */
export async function replayFixture(
  fixture: Fixture,
  llm: { fast: LlmEngine; smart: LlmEngine },
  options: Partial<SessionOptions> & { speed?: number; agent?: AgentRunner } = {},
): Promise<ReplayResult> {
  const { speed, agent, ...sessionOptions } = options;
  const source = new FixtureSource(fixture, speed === undefined ? {} : { speed });
  const session = new MeetingSession(
    source,
    source.meetingRef(),
    llm,
    {
      ...DEFAULT_SESSION_OPTIONS,
      language: fixture.meeting.language,
      ...(fixture.meeting.date ? { today: fixture.meeting.date } : {}),
      ...sessionOptions,
    },
    agent,
  );
  const events: SessionEvent[] = [];
  session.on((event) => events.push(event));
  await session.run();
  return { session, pipeline: session.pipeline, source, events };
}
