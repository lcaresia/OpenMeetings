import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@open-meetings/config";
import { describe, expect, it } from "vitest";
import { buildConfig, buildEnv, runInit } from "./init";

const examples = join(import.meta.dirname, "../../../../examples");

describe("om init", () => {
  it("adapts a profile and keeps it a valid config with its comments", () => {
    const template = readFileSync(join(examples, "cloud-cheap.yaml"), "utf8");
    const { text, variables } = buildConfig(
      {
        profile: "cloud-cheap",
        language: "en",
        externalGuests: "ask",
        internalDomains: ["acme.com"],
      },
      template,
    );
    expect(text).toContain("# Profile: cloud-cheap");
    expect(variables.sort()).toEqual(["ANTHROPIC_API_KEY", "GROQ_API_KEY", "OM_WEBHOOK_URL"]);
    const { config } = parseConfig(text, { GROQ_API_KEY: "x", ANTHROPIC_API_KEY: "y" });
    expect(config.agent.language).toBe("en");
    expect(config.consent).toMatchObject({ externalGuests: "ask", internalDomains: ["acme.com"] });
  });

  it("writes a .env with fresh tokens and the keys to fill in", () => {
    const env = buildEnv(["GROQ_API_KEY", "OM_WEBHOOK_URL"]);
    expect(env).toMatch(/^OM_AUTH_TOKEN=[0-9a-f]{48}$/m);
    expect(env).toMatch(/^OM_BOT_TOKEN=[0-9a-f]{48}$/m);
    expect(env).toContain("GROQ_API_KEY=\n");
    expect(buildEnv([])).not.toContain("API keys");
  });

  it("writes both files non-interactively and refuses to overwrite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "om-init-"));
    expect(await runInit({ dir, yes: true, profile: "local" })).toBe(0);
    const config = parseConfig(
      readFileSync(join(dir, "openmeetings.config.yaml"), "utf8"),
      {},
    ).config;
    expect(config.profile).toBe("local");
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect(await runInit({ dir, yes: true, profile: "local" })).toBe(1);
    expect(await runInit({ dir, yes: true, profile: "nope", force: true })).toBe(1);
  });
});
