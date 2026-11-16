import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFixture } from "./fixture";
import type { ChatRequest } from "./llm";
import { loadPrompt, PROMPT_NAMES, renderPrompt } from "./prompts";
import { replayFixture } from "./replay";
import { applyPatch, emptyState } from "./state";
import { createRuleLlm } from "./testing";

const fixturesDir = join(import.meta.dirname, "../../../fixtures");
const fixture = loadFixture("weekly-sync", fixturesDir);
const expected = JSON.parse(
  readFileSync(join(fixturesDir, "weekly-sync/expected.json"), "utf8"),
) as {
  decisions: { includes: string }[];
  actionItems: { includes: string; owner: string; due: string }[];
  openQuestions: { includes: string }[];
};

async function replay(responders = {}) {
  const llm = createRuleLlm(responders);
  const result = await replayFixture(fixture, { fast: llm, smart: llm });
  return { ...result, llm };
}

describe("replay: weekly-sync", () => {
  it("extracts the decisions, with the line they came from", async () => {
    const { pipeline } = await replay();
    const { decisions } = pipeline.state;
    expect(decisions).toHaveLength(expected.decisions.length);
    for (const want of expected.decisions) {
      const found = decisions.find((d) => d.text.includes(want.includes));
      expect(found, want.includes).toBeDefined();
      const cited = pipeline.segments.find((s) => s.id === found?.sourceSegmentIds[0]);
      expect(cited?.text).toContain(want.includes);
    }
  });

  it("extracts the action items with owner and due date", async () => {
    const { pipeline } = await replay();
    expect(pipeline.state.actionItems).toHaveLength(expected.actionItems.length);
    for (const want of expected.actionItems) {
      const found = pipeline.state.actionItems.find((item) => item.text.includes(want.includes));
      expect(found, want.includes).toMatchObject({ status: "open", due: want.due });
      expect(found?.owner).toContain(want.owner);
    }
  });

  it("keeps the unanswered question and the participants", async () => {
    const { pipeline } = await replay();
    expect(pipeline.state.openQuestions.map((q) => q.text).join()).toContain(
      expected.openQuestions[0]?.includes,
    );
    expect(pipeline.state.participants.map((p) => p.name)).toEqual([
      "Ana Souza",
      "Bruno Lima",
      "Carla Mendes",
    ]);
    expect(pipeline.state.title).toBe("Sync semanal do lançamento");
  });

  it("is deterministic", async () => {
    const [a, b] = await Promise.all([replay(), replay()]);
    expect(a.pipeline.state).toEqual(b.pipeline.state);
  });

  it("lets a client rebuild the exact state from the emitted patches alone", async () => {
    const { pipeline, events } = await replay();
    let client = emptyState(fixture.meeting.title);
    for (const event of events)
      if (event.type === "state") client = applyPatch(client, event.patch);
    expect(client).toEqual(pipeline.state);
  });

  it("sends each line to the model once: state plus delta, never the whole meeting", async () => {
    const { llm, pipeline } = await replay();
    const transcripts = llm.calls.map(
      (call) => call.messages[1]?.content.split("NEW TRANSCRIPT:\n")[1] ?? "",
    );
    expect(llm.calls.length).toBeGreaterThan(1);
    for (const segment of pipeline.segments) {
      expect(transcripts.filter((text) => text.includes(`[${segment.id}]`))).toHaveLength(1);
    }
    expect(
      llm.calls.every((call) => call.messages[0]?.role === "system" && call.messages[0].cache),
    ).toBe(true);
  });

  it("recovers when the model answers with garbage, then with a valid patch", async () => {
    let calls = 0;
    const { events, pipeline } = await replay({
      "state-update": (_req: ChatRequest) =>
        calls++ === 0
          ? "sorry, I cannot"
          : '{"patch":[{"op":"add","path":"/decisions/-","value":{"text":"ok"}}]}',
    });
    expect(pipeline.state.decisions[0]?.text).toBe("ok");
    expect(events.some((event) => event.type === "warning")).toBe(false);
  });

  it("warns and carries on when the model never returns a usable patch", async () => {
    const { events, pipeline } = await replay({ "state-update": () => "not json" });
    expect(pipeline.state.decisions).toEqual([]);
    expect(pipeline.segments.length).toBeGreaterThan(10);
    expect(events.filter((event) => event.type === "warning").length).toBeGreaterThan(0);
  });
});

describe("prompts", () => {
  it.each(PROMPT_NAMES)("%s matches its snapshot", (name) => {
    const rendered = renderPrompt(loadPrompt(name), {
      agentName: "Open Meetings",
      language: "pt-BR",
      today: "2026-11-16",
    });
    expect(rendered).toMatchSnapshot();
  });

  it("fails loudly on a placeholder with no value", () => {
    expect(() => renderPrompt("Hello {{who}}", {})).toThrowError(/\{\{who\}\}/);
  });
});
