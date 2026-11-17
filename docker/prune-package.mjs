// Keeps only what a runtime install needs from a workspace package.json: the published name,
// version and production dependencies. Workspace packages are bundled into dist, so the
// `workspace:` specifiers (devDependencies) must not reach npm.
import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(input, "utf8"));
const pruned = {
  name: pkg.name,
  version: pkg.version,
  private: true,
  type: pkg.type,
  dependencies: Object.fromEntries(
    Object.entries(pkg.dependencies ?? {}).filter(
      ([, spec]) => !String(spec).startsWith("workspace:"),
    ),
  ),
};
writeFileSync(output, `${JSON.stringify(pruned, null, 2)}\n`);
