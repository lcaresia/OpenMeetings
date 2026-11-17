#!/usr/bin/env node
import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "@open-meetings/config";
import { CLI_NAME, createLogger, PROJECT_NAME, VERSION } from "@open-meetings/core";
import { formatReport, runDoctor } from "./doctor";
import { runReplay } from "./replay";

const HELP = `${PROJECT_NAME} ${VERSION}

Usage: ${CLI_NAME} <command> [options]

Commands:
  serve               Start the server and the web panel
  join <link>         Send the bot to a meeting (needs a running server)
  doctor              Validate the config, test every engine, measure latency, estimate cost
  replay <fixture>    Run a recorded meeting through the pipeline and print the notes

Options:
  -c, --config <path>   Config file (default: ./openmeetings.config.yaml or $OM_CONFIG)
      --server <url>    join: server address (default: from the config)
      --title <text>    join: meeting title
      --json            Machine-readable output
      --offline         doctor: skip the engine connection tests
      --mock            replay: use the built-in deterministic model (no config, no network)
      --speed <n>       replay: play at n times real time (default: no waiting)
  -h, --help
  -v, --version
`;

async function serve(configPath?: string): Promise<number> {
  const { startApp } = await import("../app");
  const loaded = loadConfig(configPath ? { path: configPath } : {});
  const logger = createLogger("server");
  const app = await startApp(loaded, { logger });
  logger.info(
    { url: app.url, profile: loaded.config.profile },
    `${PROJECT_NAME} no ar: abra ${app.url}`,
  );
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        logger.info("encerrando: saindo das reuniões e salvando");
        void app.close().finally(resolve);
      });
    }
  });
  return 0;
}

async function join(
  link: string,
  options: { config?: string; server?: string; title?: string },
): Promise<number> {
  const { config } = loadConfig(options.config ? { path: options.config } : {});
  const host = config.server.host === "0.0.0.0" ? "127.0.0.1" : config.server.host;
  const base = options.server ?? `http://${host}:${config.server.port}`;
  const token = config.server.authToken;
  const res = await fetch(`${base}/api/meetings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ url: link, ...(options.title ? { title: options.title } : {}) }),
  }).catch((error: unknown) => {
    throw new Error(
      `could not reach the server at ${base} (is \`${CLI_NAME} serve\` running?): ${String(error)}`,
    );
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!res.ok) {
    console.error(`The server refused: ${body.error ?? res.status}`);
    return 1;
  }
  console.log(`Bot on its way. Follow the meeting at ${base}/meetings/${body.id}`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      server: { type: "string" },
      title: { type: "string" },
      json: { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
      mock: { type: "boolean", default: false },
      speed: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  const [command, argument] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return command || values.help ? 0 : 1;
  }

  switch (command) {
    case "serve":
      return serve(values.config);
    case "join":
      if (!argument) {
        console.error(`Usage: ${CLI_NAME} join <meeting link>`);
        return 1;
      }
      return join(argument, {
        ...(values.config ? { config: values.config } : {}),
        ...(values.server ? { server: values.server } : {}),
        ...(values.title ? { title: values.title } : {}),
      });
    case "doctor": {
      const loaded = loadConfig(values.config ? { path: values.config } : {});
      const report = await runDoctor(loaded, { offline: values.offline });
      console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
      return report.ok ? 0 : 1;
    }
    case "replay": {
      if (!argument) {
        console.error(`Usage: ${CLI_NAME} replay <fixture>`);
        return 1;
      }
      console.log(
        await runReplay(argument, {
          mock: values.mock,
          json: values.json,
          ...(values.config ? { config: values.config } : {}),
          ...(values.speed ? { speed: Number(values.speed) } : {}),
        }),
      );
      return 0;
    }
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(
      error instanceof ConfigError ? error.message : error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  },
);
