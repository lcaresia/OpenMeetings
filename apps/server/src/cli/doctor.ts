import { isLocalOnly, isLocalUrl, type LoadedConfig } from "@open-meetings/config";
import {
  createEngines,
  type Engines,
  estimateHourlyCost,
  type FetchLike,
  type HourlyCost,
  type LlmEngine,
} from "@open-meetings/engines";

export type CheckResult = {
  name: string;
  target: string;
  status: "ok" | "fail" | "skipped";
  latencyMs?: number;
  detail: string;
};

export type DoctorReport = {
  profile: string;
  configPath?: string;
  localOnly: boolean;
  checks: CheckResult[];
  cost: HourlyCost;
  missingEnv: string[];
  ok: boolean;
};

export type DoctorOptions = { offline?: boolean; fetch?: FetchLike; timeoutMs?: number };

/** Node's fetch hides the reason ("fetch failed") in `cause`; surface it. */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: string; message?: string } | undefined;
  const reason = cause?.code ?? cause?.message;
  return reason ? `${error.message} (${reason})` : error.message;
}

async function timed(
  name: string,
  target: string,
  run: (signal: AbortSignal) => Promise<string>,
  timeoutMs: number,
): Promise<CheckResult> {
  const started = performance.now();
  try {
    const detail = await run(AbortSignal.timeout(timeoutMs));
    return {
      name,
      target,
      status: "ok",
      latencyMs: Math.round(performance.now() - started),
      detail,
    };
  } catch (error) {
    return {
      name,
      target,
      status: "fail",
      latencyMs: Math.round(performance.now() - started),
      detail: errorText(error),
    };
  }
}

async function checkLlm(engine: LlmEngine, signal: AbortSignal): Promise<string> {
  const started = performance.now();
  let firstTokenMs: number | undefined;
  let chars = 0;
  const stream = engine.chat({
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    maxTokens: 256,
    signal,
  });
  for await (const delta of stream) {
    if (delta.type !== "text") continue;
    firstTokenMs ??= Math.round(performance.now() - started);
    chars += delta.text.length;
  }
  if (chars === 0) throw new Error("model answered with no text");
  return `first token in ${firstTokenMs} ms`;
}

function engineTargets(loaded: LoadedConfig) {
  const { llm, stt, tts, embed } = loaded.config.engines;
  const describe = (engine: { provider: string; model?: string; baseUrl?: string }) =>
    engine.provider === "none"
      ? "none"
      : `${engine.model} @ ${engine.baseUrl ? new URL(engine.baseUrl).host : engine.provider}`;
  return {
    "llm.fast": describe(llm.fast),
    "llm.smart": describe(llm.smart),
    stt: describe(stt),
    tts: describe(tts),
    embed: describe(embed),
  };
}

/** Checks that need no network: things that are wrong whatever the engines answer. */
function staticChecks(loaded: LoadedConfig): CheckResult[] {
  const { config } = loaded;
  const checks: CheckResult[] = [
    { name: "config", target: loaded.path ?? "(inline)", status: "ok", detail: "valid" },
  ];

  if (isLocalOnly(config)) {
    const { llm, stt, tts, embed } = config.engines;
    const remote = Object.entries({ "llm.fast": llm.fast, "llm.smart": llm.smart, stt, tts, embed })
      .filter(([, engine]) => {
        if (engine.provider === "none") return false;
        if (engine.provider === "anthropic") return !engine.baseUrl || !isLocalUrl(engine.baseUrl);
        return !isLocalUrl(engine.baseUrl);
      })
      .map(([name]) => name);
    checks.push({
      name: "local-only",
      target: "engines",
      status: remote.length ? "fail" : "ok",
      detail: remote.length
        ? `these engines point outside the machine and will be blocked: ${remote.join(", ")}`
        : "every engine is on a private address",
    });
  }

  const loopback = ["127.0.0.1", "localhost", "::1"].includes(config.server.host);
  if (!loopback && !config.server.authToken) {
    checks.push({
      name: "auth",
      target: `${config.server.host}:${config.server.port}`,
      status: "fail",
      detail: "server.authToken is required when the server listens on a non-loopback address",
    });
  }
  return checks;
}

async function engineChecks(
  loaded: LoadedConfig,
  engines: Engines,
  options: DoctorOptions,
): Promise<CheckResult[]> {
  const targets = engineTargets(loaded);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const skipped = (name: keyof typeof targets, detail: string): CheckResult => ({
    name,
    target: targets[name],
    status: "skipped",
    detail,
  });
  if (options.offline) {
    return (Object.keys(targets) as (keyof typeof targets)[]).map((name) =>
      skipped(name, targets[name] === "none" ? "not configured" : "offline mode"),
    );
  }

  const { stt, tts, embed } = engines;
  return Promise.all([
    timed("llm.fast", targets["llm.fast"], (s) => checkLlm(engines.llm.fast, s), timeoutMs),
    timed("llm.smart", targets["llm.smart"], (s) => checkLlm(engines.llm.smart, s), timeoutMs),
    stt
      ? timed(
          "stt",
          targets.stt,
          async (signal) => {
            const silence = { pcm: new Int16Array(16000), sampleRate: 16000, startMs: 0 };
            await stt.transcribe(silence, { signal });
            return "transcribed 1 s of audio";
          },
          timeoutMs,
        )
      : skipped("stt", "not configured: using the platform's live captions"),
    tts
      ? timed(
          "tts",
          targets.tts,
          async (signal) => {
            const audio = await tts.synthesize("ok", { signal });
            await audio.cancel();
            return "synthesized audio";
          },
          timeoutMs,
        )
      : skipped("tts", "not configured: voice replies off"),
    embed
      ? timed(
          "embed",
          targets.embed,
          async () => {
            const [vector] = await embed.embed(["ping"]);
            if (!vector?.length) throw new Error("engine returned no embedding");
            return `${vector.length} dimensions`;
          },
          timeoutMs,
        )
      : skipped("embed", "not configured: semantic search off"),
  ]);
}

export async function runDoctor(
  loaded: LoadedConfig,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const { config } = loaded;
  const engines = createEngines(config, options.fetch ? { fetch: options.fetch } : {});
  const checks = [...staticChecks(loaded), ...(await engineChecks(loaded, engines, options))];
  return {
    profile: config.profile,
    ...(loaded.path ? { configPath: loaded.path } : {}),
    localOnly: isLocalOnly(config),
    checks,
    cost: estimateHourlyCost(config),
    missingEnv: loaded.missingEnv,
    ok: checks.every((check) => check.status !== "fail"),
  };
}

const usd = (value: number | undefined) =>
  value === undefined ? "unknown" : `$${value.toFixed(4)}`;

export function formatReport(report: DoctorReport): string {
  const mark = { ok: "ok  ", fail: "FAIL", skipped: "-   " };
  const nameWidth = Math.max(...report.checks.map((check) => check.name.length));
  const targetWidth = Math.max(...report.checks.map((check) => check.target.length));
  const lines = [
    `Profile: ${report.profile}${report.localOnly ? " (local-only: outbound requests blocked)" : ""}`,
    ...(report.configPath ? [`Config:  ${report.configPath}`] : []),
    "",
    ...report.checks.map((check) => {
      const latency = check.latencyMs === undefined ? "" : ` (${check.latencyMs} ms)`;
      return `${mark[check.status]} ${check.name.padEnd(nameWidth)}  ${check.target.padEnd(targetWidth)}  ${check.detail}${latency}`;
    }),
    "",
    `Estimated cost per meeting hour: ${usd(report.cost.totalUsd)}  (fast ${usd(report.cost.fastUsd)}, smart ${usd(report.cost.smartUsd)})`,
  ];
  if (report.cost.unpricedModels.length) {
    lines.push(
      `  No price configured for: ${report.cost.unpricedModels.join(", ")} (add it under \`pricing\`)`,
    );
  }
  if (report.missingEnv.length) {
    lines.push(`Environment variables referenced but not set: ${report.missingEnv.join(", ")}`);
  }
  lines.push("", report.ok ? "All checks passed." : "Some checks failed.");
  return lines.join("\n");
}
