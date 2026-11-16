import { defineConfig } from "tsup";

export default defineConfig({
  entry: { main: "src/cli/main.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  // Workspace packages ship as TypeScript source, so they are bundled into the CLI.
  noExternal: [/^@open-meetings\//],
});
