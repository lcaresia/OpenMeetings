import { defineConfig } from "tsup";

export default defineConfig({
  entry: { main: "src/main.ts", smoke: "src/smoke.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  noExternal: [/^@open-meetings\//],
  // CommonJS dependencies of the workspace packages end up inlined in this ESM bundle and call
  // require() for Node built-ins; give them one.
  banner: {
    js: "import { createRequire as __omCreateRequire } from 'node:module'; const require = __omCreateRequire(import.meta.url);",
  },
});
