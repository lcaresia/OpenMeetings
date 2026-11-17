import { cpSync, existsSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { main: "src/cli/main.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  // Workspace packages ship as TypeScript source, so they are bundled into the CLI.
  noExternal: [/^@open-meetings\//],
  onSuccess: async () => {
    // Prompts are read from disk at runtime so users can override them.
    cpSync("../../packages/core/prompts", "dist/prompts", { recursive: true });
    // `om serve --demo` and `om replay` work outside a checkout.
    cpSync("../../fixtures", "dist/fixtures", { recursive: true });
    // `om init` starts from these profiles.
    cpSync("../../examples", "dist/examples", {
      recursive: true,
      filter: (src) => !src.includes("node_modules"),
    });
    // The panel is served by the same process; the web package builds first (workspace order).
    if (existsSync("../web/dist/index.html"))
      cpSync("../web/dist", "dist/web", { recursive: true });
  },
});
