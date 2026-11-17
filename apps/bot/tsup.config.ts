import { defineConfig } from "tsup";

export default defineConfig({
  entry: { main: "src/main.ts", smoke: "src/smoke.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  noExternal: [/^@open-meetings\//],
});
