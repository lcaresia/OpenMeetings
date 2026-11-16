import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, isLocalOnly, isLocalUrl, parseConfig } from "./index";

const examplesDir = join(import.meta.dirname, "../../../examples");
const ENV = {
  GROQ_API_KEY: "gsk-test",
  ANTHROPIC_API_KEY: "sk-ant-test",
  OPENAI_API_KEY: "sk-test",
};

const MINIMAL = `
engines:
  llm:
    fast:  { provider: openai-compatible, baseUrl: http://localhost:11434/v1, model: a }
    smart: { provider: openai-compatible, baseUrl: http://localhost:11434/v1, model: b }
`;

describe("parseConfig", () => {
  it("applies defaults to a minimal config", () => {
    const { config } = parseConfig(MINIMAL, {});
    expect(config.engines.stt).toEqual({ provider: "none" });
    expect(config.agent.summaryIntervalSec).toBe(45);
    expect(config.consent.externalGuests).toBe("allow");
    expect(config.storage).toEqual({ driver: "sqlite", path: "./data/openmeetings.db" });
    expect(config.interop.agui).toEqual({ enabled: true, path: "/agui" });
  });

  it("expands ${VAR} inside YAML flow maps, where braces are otherwise invalid", () => {
    const yaml = MINIMAL.replace("model: a }", "model: a, apiKey: ${GROQ_API_KEY} }");
    const { config } = parseConfig(yaml, { GROQ_API_KEY: "key: with #yaml {chars}" });
    expect(config.engines.llm.fast).toMatchObject({ apiKey: "key: with #yaml {chars}" });
  });

  it("supports ${VAR:-fallback} and reports unset optional variables", () => {
    const yaml = `${MINIMAL.replace("http://localhost:11434/v1, model: a", '"${URL:-http://ollama:11434/v1}", model: a')}
outputs:
  webhookUrl: \${OM_WEBHOOK_URL}
`;
    const { config, missingEnv } = parseConfig(yaml, {});
    expect(config.engines.llm.fast).toMatchObject({ baseUrl: "http://ollama:11434/v1" });
    expect(config.outputs.webhookUrl).toBeUndefined();
    expect(missingEnv).toEqual(["OM_WEBHOOK_URL"]);
  });

  it("names the missing variable when a required key is unset", () => {
    const yaml = MINIMAL.replace(
      "{ provider: openai-compatible, baseUrl: http://localhost:11434/v1, model: b }",
      "{ provider: anthropic, model: claude-haiku-5-5, apiKey: ${ANTHROPIC_API_KEY} }",
    );
    expect(() => parseConfig(yaml, {})).toThrowError(/ANTHROPIC_API_KEY/);
    expect(() => parseConfig(yaml, {})).toThrowError(ConfigError);
  });

  it("refuses to disable the join announcement", () => {
    const yaml = `${MINIMAL}\nconsent:\n  announceOnJoin: false\n`;
    expect(() => parseConfig(yaml, {})).toThrowError(/must identify itself/);
  });

  it("treats profile local as local-only unless overridden", () => {
    expect(isLocalOnly(parseConfig(`profile: local\n${MINIMAL}`, {}).config)).toBe(true);
    expect(isLocalOnly(parseConfig(MINIMAL, {}).config)).toBe(false);
  });
});

describe("examples", () => {
  const files = readdirSync(examplesDir).filter((name) => name.endsWith(".yaml"));

  it("ships the four documented profiles", () => {
    expect(files.sort()).toEqual([
      "cloud-best.yaml",
      "cloud-cheap.yaml",
      "hybrid.yaml",
      "local.yaml",
    ]);
  });

  it.each(files)("%s is valid", (file) => {
    const { config } = parseConfig(readFileSync(join(examplesDir, file), "utf8"), ENV);
    expect(config.profile).toBe(file.replace(".yaml", ""));
  });
});

describe("isLocalUrl", () => {
  it.each([
    "http://localhost:11434/v1",
    "http://127.0.0.1:8000",
    "http://ollama:11434/v1",
    "http://192.168.1.20:8080",
    "http://10.0.0.5",
    "http://172.20.0.3:9000",
    "http://host.docker.internal:11434",
    "http://[::1]:8000",
  ])("%s is local", (url) => expect(isLocalUrl(url)).toBe(true));

  it.each([
    "https://api.groq.com/openai/v1",
    "https://api.anthropic.com",
    "http://8.8.8.8",
    "http://172.32.0.1",
    "not a url",
  ])("%s is not local", (url) => expect(isLocalUrl(url)).toBe(false));
});
