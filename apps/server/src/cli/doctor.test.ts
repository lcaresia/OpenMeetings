import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "@open-meetings/config";
import { anthropicStream, fakeFetch, openAiTextStream } from "@open-meetings/engines/testing";
import { describe, expect, it } from "vitest";
import { formatReport, runDoctor } from "./doctor";

const example = (name: string) =>
  readFileSync(join(import.meta.dirname, "../../../../examples", `${name}.yaml`), "utf8");

const ENV = { GROQ_API_KEY: "gsk", ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk" };

/** Answers like a healthy provider would, whichever endpoint is hit. */
function healthy() {
  return fakeFetch(({ url }) => {
    if (url.endsWith("/v1/messages")) return anthropicStream({ text: "ok" });
    if (url.endsWith("/chat/completions")) return openAiTextStream("ok");
    if (url.endsWith("/embeddings"))
      return Response.json({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] });
    if (url.endsWith("/audio/transcriptions")) return Response.json({ text: "" });
    if (url.endsWith("/audio/speech")) return new Response(new Uint8Array([1, 2, 3]));
    return new Response("not found", { status: 404 });
  });
}

describe("om doctor", () => {
  it("passes on the cloud-cheap profile and stays under the cost target", async () => {
    const { fetchFn } = healthy();
    const report = await runDoctor(parseConfig(example("cloud-cheap"), ENV), { fetch: fetchFn });

    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.name === "llm.fast")).toMatchObject({
      status: "ok",
      target: "llama-3.1-8b-instant @ api.groq.com",
    });
    expect(report.checks.find((check) => check.name === "stt")?.status).toBe("skipped");
    expect(report.cost.totalUsd).toBeLessThan(0.05);
    expect(report.missingEnv).toEqual(["OM_WEBHOOK_URL"]);
    expect(formatReport(report)).toContain("All checks passed.");
  });

  it("makes no request outside the machine on the local profile", async () => {
    const { fetchFn, requests } = healthy();
    const report = await runDoctor(parseConfig(example("local"), {}), { fetch: fetchFn });

    expect(report.ok).toBe(true);
    expect(report.localOnly).toBe(true);
    expect(report.cost.totalUsd).toBe(0);
    expect(requests.length).toBeGreaterThanOrEqual(4);
    expect([...new Set(requests.map((request) => new URL(request.url).hostname))]).toEqual([
      "localhost",
    ]);
  });

  it("fails when the local profile names a remote engine, without calling it", async () => {
    const { fetchFn, requests } = healthy();
    const yaml = `
profile: local
engines:
  llm:
    fast: { provider: openai-compatible, baseUrl: http://localhost:11434/v1, model: a }
    smart: { provider: openai-compatible, baseUrl: https://api.groq.com/openai/v1, model: x }
`;
    const report = await runDoctor(parseConfig(yaml, {}), { fetch: fetchFn });

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "local-only")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("llm.smart"),
    });
    expect(report.checks.find((check) => check.name === "llm.smart")?.detail).toMatch(/local-only/);
    expect(requests.some((request) => request.url.includes("groq"))).toBe(false);
  });

  it("reports an engine that is down and keeps checking the others", async () => {
    const { fetchFn } = fakeFetch(({ url }) =>
      url.includes("groq")
        ? new Response("invalid api key", { status: 401 })
        : anthropicStream({ text: "ok" }),
    );
    const report = await runDoctor(parseConfig(example("cloud-cheap"), ENV), { fetch: fetchFn });

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === "llm.fast")?.detail).toMatch(/HTTP 401/);
    expect(report.checks.find((check) => check.name === "llm.smart")?.status).toBe("ok");
  });

  it("requires an auth token to listen on a public address", async () => {
    const yaml = `${example("local")}\nserver:\n  host: 0.0.0.0\n`;
    const report = await runDoctor(parseConfig(yaml, {}), { offline: true });
    expect(report.checks.find((check) => check.name === "auth")?.status).toBe("fail");
  });

  it("never prints an API key", async () => {
    const { fetchFn } = healthy();
    const env = {
      ...ENV,
      GROQ_API_KEY: "gsk-super-secret",
      ANTHROPIC_API_KEY: "sk-ant-super-secret",
    };
    const report = await runDoctor(parseConfig(example("cloud-cheap"), env), { fetch: fetchFn });
    expect(`${formatReport(report)}${JSON.stringify(report)}`).not.toContain("super-secret");
  });
});
