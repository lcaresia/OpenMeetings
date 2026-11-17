import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_FILE_NAME } from "@open-meetings/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { maskEnvRefs, resolveEnvRefs } from "./env";
import { type Config, configSchema } from "./schema";

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly missingEnv: string[] = [],
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export type LoadedConfig = {
  config: Config;
  /** Absolute path of the file, when loaded from disk. */
  path?: string;
  /** `${VARS}` referenced by the file but not set. Only optional fields can reach this point. */
  missingEnv: string[];
};

type Env = Record<string, string | undefined>;

/**
 * Deployment settings that belong to the environment rather than to the shared config file
 * (containers, VPS). They win over the file.
 */
export const ENV_OVERRIDES: Record<string, [section: string, key: string, kind?: "boolean"]> = {
  OM_HOST: ["server", "host"],
  OM_PORT: ["server", "port"],
  OM_AUTH_TOKEN: ["server", "authToken"],
  OM_DB_PATH: ["storage", "path"],
  OM_BOT_SPAWN: ["bot", "spawn", "boolean"],
  OM_BOT_TOKEN: ["bot", "token"],
  OM_BOT_HEADLESS: ["bot", "headless", "boolean"],
};

function applyEnvOverrides(config: Record<string, unknown>, env: Env): void {
  for (const [name, [section, key, kind]] of Object.entries(ENV_OVERRIDES)) {
    const value = env[name];
    if (value === undefined || value === "") continue;
    config[section] ??= {};
    const target = config[section] as Record<string, unknown>;
    target[key] = kind === "boolean" ? !/^(0|false|no|off)$/i.test(value) : value;
    // A database file path means SQLite; without this a file with no `storage` section fails.
    if (name === "OM_DB_PATH") target.driver ??= "sqlite";
  }
}

export function parseConfig(yamlText: string, env: Env = process.env): LoadedConfig {
  const { masked, refs } = maskEnvRefs(yamlText);
  let raw: unknown;
  try {
    raw = parseYaml(masked);
  } catch (error) {
    throw new ConfigError(`Invalid YAML: ${(error as Error).message}`);
  }
  const missing = new Set<string>();
  const resolved = resolveEnvRefs(raw ?? {}, refs, env, missing);
  applyEnvOverrides(resolved as Record<string, unknown>, env);
  const result = configSchema.safeParse(resolved);
  const missingEnv = [...missing].sort();
  if (!result.success) {
    const hint = missingEnv.length
      ? `\nEnvironment variables referenced but not set: ${missingEnv.join(", ")}`
      : "";
    throw new ConfigError(`Invalid config:\n${z.prettifyError(result.error)}${hint}`, missingEnv);
  }
  return { config: result.data, missingEnv };
}

export function resolveConfigPath(path?: string, env: Env = process.env): string {
  return resolve(path ?? env.OM_CONFIG ?? CONFIG_FILE_NAME);
}

export function loadConfig(options: { path?: string; env?: Env } = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const path = resolveConfigPath(options.path, env);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(
      `Config file not found: ${path}\nCreate one with \`om init\` or copy a profile from examples/.`,
    );
  }
  return { ...parseConfig(text, env), path };
}
