/**
 * pnpm eval: runs every recorded meeting in fixtures/ through the real pipeline and scores what
 * was extracted against the fixture's expected.json.
 *
 *   pnpm eval                      models from ./openmeetings.config.yaml (or $OM_CONFIG)
 *   pnpm eval --config examples/local.yaml
 *   pnpm eval --mock               the deterministic model (what CI runs)
 *
 * Writes eval-report.md. Running it with hosted models costs a few cents per fixture.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "@open-meetings/config";
import { type LlmEngine, loadFixture, type MeetingState, replayFixture } from "@open-meetings/core";
import { createRuleLlm } from "@open-meetings/core/testing";
import { createEngines } from "@open-meetings/engines";

type Expected = {
  decisions: { includes: string }[];
  actionItems: { includes: string; owner?: string; due?: string }[];
  openQuestions: { includes: string }[];
  commands?: { said: string; replyIncludes: string[] }[];
};

type Score = { expected: number; found: number; matched: number };

const norm = (text: string) => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const has = (text: string | undefined, part: string) =>
  Boolean(text && norm(text).includes(norm(part)));

/** Greedy one-to-one matching of expected entries to extracted ones. */
function score<E, F>(expected: E[], found: F[], match: (e: E, f: F) => boolean): Score {
  const used = new Set<number>();
  let matched = 0;
  for (const want of expected) {
    const index = found.findIndex((item, i) => !used.has(i) && match(want, item));
    if (index !== -1) {
      used.add(index);
      matched++;
    }
  }
  return { expected: expected.length, found: found.length, matched };
}

const pct = (n: number, d: number) => (d === 0 ? "-" : `${Math.round((n / d) * 100)}%`);

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: "string" },
      mock: { type: "boolean", default: false },
      out: { type: "string" },
    },
  });
  let llm: { fast: LlmEngine; smart: LlmEngine };
  let label: string;
  if (values.mock) {
    const rule = createRuleLlm();
    llm = { fast: rule, smart: rule };
    label = "deterministic mock";
  } else {
    const { config, path } = loadConfig(values.config ? { path: values.config } : {});
    llm = createEngines(config).llm;
    label = `${config.engines.llm.fast.model} (fast) / ${config.engines.llm.smart.model} (smart), ${path}`;
  }

  const rows: string[] = [];
  const zero = (): Score => ({ expected: 0, found: 0, matched: 0 });
  const totals = {
    decisions: zero(),
    actionItems: zero(),
    questions: zero(),
    owners: { expected: 0, right: 0 },
    commands: { expected: 0, answered: 0 },
  };
  for (const name of readdirSync("fixtures")) {
    const expectedPath = join("fixtures", name, "expected.json");
    if (!existsSync(expectedPath)) continue;
    const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as Expected;
    const fixture = loadFixture(name);
    const started = performance.now();
    const { pipeline, events } = await replayFixture(fixture, llm);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const state: MeetingState = pipeline.state;
    const replies = events.flatMap((event) => (event.type === "reply" ? [event.text] : []));

    const decisions = score(expected.decisions, state.decisions, (e, f) => has(f.text, e.includes));
    const actions = score(expected.actionItems, state.actionItems, (e, f) =>
      has(f.text, e.includes),
    );
    const owners = expected.actionItems.filter((e) =>
      state.actionItems.some(
        (f) =>
          has(f.text, e.includes) &&
          (!e.owner || has(f.owner, e.owner)) &&
          (!e.due || has(f.due, e.due)),
      ),
    ).length;
    const questions = score(expected.openQuestions, state.openQuestions, (e, f) =>
      has(f.text, e.includes),
    );
    const commands = (expected.commands ?? []).filter((c) =>
      replies.some((reply) => c.replyIncludes.every((part) => has(reply, part))),
    ).length;

    for (const [key, s] of [
      ["decisions", decisions],
      ["actionItems", actions],
      ["questions", questions],
    ] as const) {
      totals[key].expected += s.expected;
      totals[key].found += s.found;
      totals[key].matched += s.matched;
    }
    totals.owners.expected += expected.actionItems.length;
    totals.owners.right += owners;
    totals.commands.expected += expected.commands?.length ?? 0;
    totals.commands.answered += commands;

    rows.push(
      `| ${name} | ${decisions.matched}/${decisions.expected} (${decisions.found} found) | ${actions.matched}/${actions.expected} (${actions.found} found) | ${owners}/${expected.actionItems.length} | ${questions.matched}/${questions.expected} | ${commands}/${expected.commands?.length ?? 0} | ${seconds} s |`,
    );
  }

  const { decisions: d, actionItems: a, questions: q } = totals;
  const report = `# Extraction quality

Models: ${label}
Date: ${new Date().toISOString().slice(0, 10)}

| Fixture | Decisions | Action items | Owner + due right | Open questions | Commands answered | Time |
| --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

| Metric | Recall | Precision |
| --- | --- | --- |
| Decisions | ${pct(d.matched, d.expected)} | ${pct(d.matched, d.found)} |
| Action items | ${pct(a.matched, a.expected)} | ${pct(a.matched, a.found)} |
| Action items with owner and due date right | ${pct(totals.owners.right, totals.owners.expected)} | |
| Open questions | ${pct(q.matched, q.expected)} | ${pct(q.matched, q.found)} |
| Spoken commands answered | ${pct(totals.commands.answered, totals.commands.expected)} | |
`;
  const out = values.out ?? "eval-report.md";
  writeFileSync(out, report);
  console.log(report);
  console.log(`Report written to ${out}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
