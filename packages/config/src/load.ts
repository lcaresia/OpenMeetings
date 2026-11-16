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
