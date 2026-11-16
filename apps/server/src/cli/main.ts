#!/usr/bin/env node
import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "@open-meetings/config";
import { CLI_NAME, PROJECT_NAME, VERSION } from "@open-meetings/core";
import { formatReport, runDoctor } from "./doctor";
import { runReplay } from "./replay";

const HELP = `${PROJECT_NAME} ${VERSION}

Usage: ${CLI_NAME} <command> [options]

Commands:
  doctor              Validate the config, test every engine, measure latency, estimate cost
  replay <fixture>    Run a recorded meeting through the pipeline and print the notes

Options:
  -c, --config <path>   Config file (default: ./openmeetings.config.yaml or $OM_CONFIG)
      --json            Machine-readable output
      --offline         doctor: skip the engine connection tests
      --mock            replay: use the built-in deterministic model (no config, no network)
      --speed <n>       replay: play at n times real time (default: no waiting)
  -h, --help
  -v, --version
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
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
    console.error(error instanceof ConfigError ? error.message : error);
    process.exitCode = 1;
  },
);
