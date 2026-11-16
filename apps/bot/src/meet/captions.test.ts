import type { TranscriptSegment } from "@open-meetings/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptionStabilizer } from "./captions";

describe("CaptionStabilizer", () => {
  let segments: TranscriptSegment[];
  let stabilizer: CaptionStabilizer;
  const finals = () =>
    segments.filter((segment) => !segment.partial).map((segment) => segment.text);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    segments = [];
    stabilizer = new CaptionStabilizer({
      stableMs: 1000,
      clock: () => Date.now(),
      onSegment: (segment) => segments.push(segment),
    });
  });
  afterEach(() => vi.useRealTimers());

  it("emits partials while the text is rewritten and one final once it settles", () => {
    for (const text of ["bom", "bom dia", "bom dia pessoal", "Bom dia, pessoal"]) {
      stabilizer.update("b1", "Ana", text);
      vi.advanceTimersByTime(300);
    }
    expect(finals()).toEqual([]);
    expect(segments.every((segment) => segment.partial && segment.id === "cap-b1-0")).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(finals()).toEqual(["Bom dia, pessoal"]);
    expect(segments.at(-1)).toMatchObject({
      id: "cap-b1-0",
      speaker: "Ana",
      startMs: 0,
      source: "captions",
    });
  });

  it("does not emit the same text twice", () => {
    stabilizer.update("b1", "Ana", "olá");
    stabilizer.update("b1", "Ana", "olá");
    stabilizer.update("b1", "Ana", " olá ");
    expect(segments).toHaveLength(1);
  });

  it("commits finished sentences of a long monologue without waiting for silence", () => {
    stabilizer.update("b1", "Bruno", "A API está pronta.");
    stabilizer.update("b1", "Bruno", "A API está pronta. Falta revisar o");
    expect(finals()).toEqual(["A API está pronta."]);
    stabilizer.update("b1", "Bruno", "A API está pronta. Falta revisar o contrato. E depois");
    expect(finals()).toEqual(["A API está pronta.", "Falta revisar o contrato."]);

    vi.advanceTimersByTime(1000);
    expect(finals()).toEqual(["A API está pronta.", "Falta revisar o contrato.", "E depois"]);
    expect(new Set(segments.filter((s) => !s.partial).map((s) => s.id)).size).toBe(3);
  });

  it("keeps partial and final ids aligned so the UI can replace in place", () => {
    stabilizer.update("b1", "Ana", "Primeira frase. Segunda");
    const partial = segments.find((segment) => segment.partial);
    expect(partial).toMatchObject({ id: "cap-b1-1", text: "Segunda" });
    vi.advanceTimersByTime(1000);
    expect(segments.at(-1)).toMatchObject({ id: "cap-b1-1", text: "Segunda" });
    expect(segments.at(-1)?.partial).toBeUndefined();
  });

  it("finalizes a block when it leaves the screen and keeps speakers apart", () => {
    stabilizer.update("b1", "Ana", "eu acho que sim");
    stabilizer.update("b2", "Carla", "concordo");
    stabilizer.remove("b1");
    expect(finals()).toEqual(["eu acho que sim"]);
    stabilizer.flush();
    expect(finals()).toEqual(["eu acho que sim", "concordo"]);
    expect(segments.at(-1)?.speaker).toBe("Carla");
  });

  it("survives Meet rewriting text that was already committed", () => {
    stabilizer.update("b1", "Ana", "Vamos lançar. Depois");
    stabilizer.update("b1", "Ana", "Vamos lançar em dezembro. Depois vemos");
    vi.advanceTimersByTime(1000);
    expect(finals().join(" ")).toContain("Depois vemos");
  });
});
