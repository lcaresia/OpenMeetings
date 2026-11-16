import { type Fixture, FixtureSource } from "./fixture";
import type { LlmEngine } from "./llm";
import { MeetingPipeline, type PipelineEvent, type PipelineOptions } from "./pipeline";

export type ReplayResult = {
  pipeline: MeetingPipeline;
  source: FixtureSource;
  events: PipelineEvent[];
};

/** Runs a recorded meeting through the real pipeline, as fast as `speed` allows. */
export async function replayFixture(
  fixture: Fixture,
  llm: { fast: LlmEngine; smart: LlmEngine },
  options: Partial<PipelineOptions> & { speed?: number } = {},
): Promise<ReplayResult> {
  const { speed, ...pipelineOptions } = options;
  const source = new FixtureSource(fixture, speed === undefined ? {} : { speed });
  const pipeline = new MeetingPipeline(source.meetingRef(), llm, {
    agentName: "Open Meetings",
    language: fixture.meeting.language,
    summaryIntervalSec: 45,
    ...(fixture.meeting.date ? { today: fixture.meeting.date } : {}),
    ...pipelineOptions,
  });
  const events: PipelineEvent[] = [];
  pipeline.on((event) => events.push(event));
  await pipeline.run(source.start());
  return { pipeline, source, events };
}
