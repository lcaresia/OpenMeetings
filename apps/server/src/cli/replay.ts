import { loadConfig } from "@open-meetings/config";
import { loadFixture, type MeetingState, replayFixture } from "@open-meetings/core";
import { createRuleLlm } from "@open-meetings/core/testing";
import { createEngines } from "@open-meetings/engines";

export type ReplayOptions = { config?: string; mock?: boolean; speed?: number; json?: boolean };

export function formatState(state: MeetingState): string {
  const section = (title: string, lines: string[]) => [
    `${title} (${lines.length})`,
    ...lines.map((l) => `  - ${l}`),
  ];
  return [
    state.title ?? "(untitled meeting)",
    `Participants: ${state.participants.map((p) => p.name).join(", ") || "-"}`,
    "",
    ...section(
      "Decisions",
      state.decisions.map((d) => d.text),
    ),
    ...section(
      "Action items",
      state.actionItems.map(
        (a) =>
          `${a.text}${a.owner ? ` [${a.owner}]` : ""}${a.due ? ` (due ${a.due})` : ""}${a.status === "done" ? " ✓" : ""}`,
      ),
    ),
    ...section(
      "Open questions",
      state.openQuestions.map((q) => q.text),
    ),
    "",
    `Summary: ${state.rollingSummary || "-"}`,
  ].join("\n");
}

/** `om replay <fixture>`: runs a recorded meeting through the pipeline and prints the result. */
export async function runReplay(fixtureName: string, options: ReplayOptions): Promise<string> {
  const fixture = loadFixture(fixtureName);
  let llm: Parameters<typeof replayFixture>[1];
  let promptOverrides: Record<string, string> | undefined;
  if (options.mock) {
    const rule = createRuleLlm();
    llm = { fast: rule, smart: rule };
  } else {
    const { config } = loadConfig(options.config ? { path: options.config } : {});
    llm = createEngines(config).llm;
    promptOverrides = config.prompts;
  }

  const { pipeline, events } = await replayFixture(fixture, llm, {
    ...(options.speed ? { speed: options.speed } : {}),
    ...(promptOverrides ? { promptOverrides } : {}),
  });
  const warnings = events.flatMap((event) => (event.type === "warning" ? [event.message] : []));
  if (options.json)
    return JSON.stringify(
      { state: pipeline.state, segments: pipeline.segments, warnings },
      null,
      2,
    );
  return [formatState(pipeline.state), ...warnings.map((w) => `warning: ${w}`)].join("\n");
}
