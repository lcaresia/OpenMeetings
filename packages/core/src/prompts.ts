import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const PROMPT_NAMES = ["state-update", "intent", "agent", "minutes"] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

/** `prompts/` sits next to `src/` in the repo and next to the bundle in a published build. */
function promptsDir(): string {
  const here = import.meta.dirname;
  const found = [join(here, "../prompts"), join(here, "prompts")].find((dir) => existsSync(dir));
  if (!found) throw new Error("Built-in prompts directory not found");
  return found;
}

const cache = new Map<string, string>();

/** Reads a built-in prompt, or the user's override when the config names one. */
export function loadPrompt(name: PromptName, overrides: Record<string, string> = {}): string {
  const path = overrides[name] ? resolve(overrides[name]) : join(promptsDir(), `${name}.md`);
  let text = cache.get(path);
  if (text === undefined) {
    text = readFileSync(path, "utf8").trim();
    cache.set(path, text);
  }
  return text;
}

/** Fills `{{placeholders}}`. An unknown placeholder is an error, not a silent blank. */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`Prompt placeholder {{${key}}} has no value`);
    return value;
  });
}
