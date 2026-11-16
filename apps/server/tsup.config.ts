import { cpSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { main: "src/cli/main.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  // Workspace packages ship as TypeScript source, so they are bundled into the CLI.
  noExternal: [/^@open-meetings\//],
  // Prompts are read from disk at runtime so users can override them; ship them next to the bundle.
  onSuccess: async () => {
    cpSync("../../packages/core/prompts", "dist/prompts", { recursive: true });
  },
});
