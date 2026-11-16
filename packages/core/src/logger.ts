import pino, { type Logger } from "pino";

/** Paths that must never reach a log line. */
export const REDACT_PATHS = [
  "apiKey",
  "*.apiKey",
  "*.*.apiKey",
  "*.*.*.apiKey",
  "authToken",
  "*.authToken",
  "token",
  "*.token",
  "authorization",
  "*.authorization",
  "headers.authorization",
  'headers["x-api-key"]',
  "env",
  "*.env",
  "*.*.env",
];

export function createLogger(name: string, level = process.env.OM_LOG_LEVEL ?? "info"): Logger {
  return pino({
    name,
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  });
}

export type { Logger };
