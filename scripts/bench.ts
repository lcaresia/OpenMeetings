/**
 * pnpm bench: latency of a spoken command (from the end of the sentence to the reply in the chat)
 * and cost per meeting hour, for each profile in examples/ (or the configs you pass).
 *
 *   pnpm bench                         estimate cost; latency only where the engines answer
 *   pnpm bench --live                  also run commands against the real engines (costs money
 *                                      on hosted profiles; skipped when keys are missing)
 *   pnpm bench --config my.yaml --live
 *
 * Writes bench-report.md.
 */
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ConfigError, type LoadedConfig, loadConfig } from "@open-meetings/config";
import {
  DEFAULT_SESSION_OPTIONS,
  type Fixture,
  FixtureSource,
  type LlmEngine,
  MeetingSession,
} from "@open-meetings/core";
import { createRuleLlm } from "@open-meetings/core/testing";
import { createEngines, estimateHourlyCost } from "@open-meetings/engines";

const COMMANDS = ["quais são os itens de ação?", "o que decidimos?", "faça um resumo até agora"];

/** A short meeting where someone asks the assistant something after each topic. */
function benchMeeting(): Fixture {
  const lines = [
    "Bom dia. Vamos revisar o lançamento do aplicativo.",
    "Então fica decidido que o lançamento será no dia 15 de dezembro.",
    "Bruno, você fica responsável por atualizar o contrato com o gateway até sexta-feira.",
  ];
  const events: Fixture["events"] = [{ t: 0, type: "join", participant: "ana" }];
  let t = 1000;
  for (const line of lines) {
    events.push({ t, type: "caption", speaker: "ana", text: line });
    t += 6000;
  }
  for (const command of COMMANDS) {
    events.push({ t, type: "caption", speaker: "ana", text: `Open Meetings, ${command}` });
    t += 20_000;
  }
  return {
    meeting: { id: "bench", language: "pt-BR" },
    participants: [{ id: "ana", name: "Ana" }],
    events,
  };
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? Number.NaN;
};

async function commandLatencies(llm: { fast: LlmEngine; smart: LlmEngine }): Promise<number[]> {
  const latencies: number[] = [];
  const fixture = benchMeeting();
  // Time each command from the moment its line is handed to the session to the reply.
  const source = new FixtureSource(fixture, { speed: 50 });
  const session = new MeetingSession(source, source.meetingRef(), llm, {
    ...DEFAULT_SESSION_OPTIONS,
    language: "pt-BR",
  });
  const heard = new Map<string, number>();
  session.on((event) => {
    if (event.type === "transcript" && !event.segment.partial)
      heard.set(event.segment.id, performance.now());
    if (event.type === "reply" && event.command?.sourceSegmentId) {
      const at = heard.get(event.command.sourceSegmentId);
      if (at !== undefined) latencies.push(performance.now() - at);
    }
  });
  await session.run();
  return latencies;
}

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: "string", multiple: true },
      live: { type: "boolean", default: false },
      out: { type: "string" },
    },
  });
  const paths = values.config?.length
    ? values.config
    : readdirSync("examples")
        .filter((file) => file.endsWith(".yaml"))
        .map((file) => join("examples", file));

  const rows: string[] = [];
  // Pipeline overhead alone, with an instant model: the floor every profile adds to.
  const rule = createRuleLlm();
  const floor = await commandLatencies({ fast: rule, smart: rule });
  rows.push(
    `| (pipeline only, instant model) | US$ 0.0000 | ${percentile(floor, 50).toFixed(0)} ms | ${percentile(floor, 95).toFixed(0)} ms |`,
  );

  for (const path of paths) {
    let loaded: LoadedConfig;
    try {
      loaded = loadConfig({ path });
    } catch (error) {
      const missing =
        error instanceof ConfigError && error.missingEnv.length
          ? `needs ${error.missingEnv.join(", ")}`
          : String(error);
      // Cost needs no key: estimate it with placeholders.
      const placeholders = Object.fromEntries(
        (error instanceof ConfigError ? error.missingEnv : []).map((name) => [
          name,
          // Valid as a key and as a URL, so every field type accepts it.
          "https://placeholder.invalid",
        ]),
      );
      try {
        loaded = loadConfig({ path, env: { ...process.env, ...placeholders } });
      } catch {
        rows.push(`| ${path} | ? | skipped (${missing}) | |`);
        continue;
      }
      const cost = estimateHourlyCost(loaded.config).totalUsd;
      rows.push(
        `| ${loaded.config.profile} | ${cost === undefined ? "?" : `US$ ${cost.toFixed(4)}`} | not measured (${missing}) | |`,
      );
      continue;
    }
    const cost = estimateHourlyCost(loaded.config).totalUsd;
    let p50 = "not measured (use --live)";
    let p95 = "";
    if (values.live) {
      try {
        const latencies = await commandLatencies(createEngines(loaded.config).llm);
        p50 = `${(percentile(latencies, 50) / 1000).toFixed(2)} s`;
        p95 = `${(percentile(latencies, 95) / 1000).toFixed(2)} s`;
      } catch (error) {
        p50 = `failed: ${(error as Error).message.slice(0, 80)}`;
      }
    }
    rows.push(
      `| ${loaded.config.profile} | ${cost === undefined ? "?" : `US$ ${cost.toFixed(4)}`} | ${p50} | ${p95} |`,
    );
  }

  const report = `# Benchmark

Date: ${new Date().toISOString().slice(0, 10)}. Latency: from the end of a spoken command to the
reply in the call chat, over ${COMMANDS.length} commands. Cost: estimated per meeting hour from
the configured prices and the workload model in packages/engines/src/cost.ts.

| Profile | Cost per hour | Latency p50 | Latency p95 |
| --- | --- | --- | --- |
${rows.join("\n")}
`;
  const out = values.out ?? "bench-report.md";
  writeFileSync(out, report);
  console.log(report);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
