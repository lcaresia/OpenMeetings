import { describe, expect, it } from "vitest";
import { applyModelPatch, applyPatch, emptyState, type MeetingState, updateState } from "./state";

const context = { nowMs: 60_000, knownSegmentIds: new Set(["s1", "s2"]) };

function seeded(): MeetingState {
  return applyModelPatch(
    emptyState("Sync"),
    [
      {
        op: "add",
        path: "/decisions/-",
        value: { text: "Lançar dia 15", sourceSegmentIds: ["s1"] },
      },
      { op: "add", path: "/actionItems/-", value: { text: "Atualizar contrato", owner: "Bruno" } },
      { op: "add", path: "/openQuestions/-", value: { text: "Jurídico aprovou?" } },
    ],
    context,
  ).state;
}

describe("applyModelPatch", () => {
  it("assigns ids, timestamps and status to new entries", () => {
    const state = seeded();
    expect(state.decisions).toEqual([
      { id: "dec-1", text: "Lançar dia 15", at: 60_000, sourceSegmentIds: ["s1"] },
    ]);
    expect(state.actionItems).toEqual([
      {
        id: "act-1",
        text: "Atualizar contrato",
        owner: "Bruno",
        status: "open",
        sourceSegmentIds: [],
      },
    ]);
    expect(state.openQuestions[0]).toMatchObject({ id: "q-1", at: 60_000 });
  });

  it("returns a patch that reproduces the new state exactly", () => {
    const prev = seeded();
    const { state, patch } = applyModelPatch(
      prev,
      [
        { op: "replace", path: "/actionItems/0/status", value: "done" },
        { op: "remove", path: "/openQuestions/0" },
        { op: "add", path: "/decisions/-", value: { text: "Manter plano gratuito" } },
        { op: "replace", path: "/rollingSummary", value: "Resumo novo." },
      ],
      context,
    );
    expect(state.actionItems[0]?.status).toBe("done");
    expect(state.openQuestions).toEqual([]);
    expect(state.decisions.map((d) => d.id)).toEqual(["dec-1", "dec-2"]);
    expect(applyPatch(prev, patch)).toEqual(state);
  });

  it("drops citations of segments that do not exist", () => {
    const { state } = applyModelPatch(
      emptyState(),
      [
        {
          op: "add",
          path: "/decisions/-",
          value: { text: "x", sourceSegmentIds: ["s2", "s99", 7] },
        },
      ],
      context,
    );
    expect(state.decisions[0]?.sourceSegmentIds).toEqual(["s2"]);
  });

  it("keeps the valid operations when one is broken", () => {
    const { state, rejected } = applyModelPatch(
      seeded(),
      [
        { op: "replace", path: "/actionItems/9/status", value: "done" },
        { op: "add", path: "/decisions/-", value: { text: "Segunda decisão" } },
      ],
      context,
    );
    expect(state.decisions).toHaveLength(2);
    expect(rejected).toHaveLength(1);
  });

  it("refuses to let a model touch participants or artifacts", () => {
    const prev = updateState(
      seeded(),
      (draft) => void draft.participants.push({ id: "ana", name: "Ana" }),
    ).state;
    const { state, rejected } = applyModelPatch(
      prev,
      [
        { op: "remove", path: "/participants/0" },
        { op: "add", path: "/artifacts/-", value: { id: "a", type: "doc", url: "http://evil" } },
      ],
      context,
    );
    expect(state).toEqual(prev);
    expect(rejected).toHaveLength(2);
  });

  it("does not let a model forge or duplicate ids", () => {
    const { state } = applyModelPatch(
      seeded(),
      [
        { op: "add", path: "/decisions/-", value: { id: "dec-1", text: "Cópia" } },
        { op: "add", path: "/decisions/-", value: { id: "inventado", text: "Outra" } },
      ],
      context,
    );
    expect(state.decisions.map((d) => d.id)).toEqual(["dec-1", "dec-2", "dec-3"]);
  });

  it("discards entries with no text and ignores a non-list patch", () => {
    const prev = seeded();
    expect(
      applyModelPatch(prev, [{ op: "add", path: "/decisions/-", value: { by: "Ana" } }], context)
        .state,
    ).toEqual(prev);
    expect(applyModelPatch(prev, "nonsense", context)).toMatchObject({ state: prev, patch: [] });
  });
});
