// Starts the built bundles (not the TypeScript sources the tests use) and checks they boot.
// Catches bundling mistakes such as CommonJS `require` inside an ESM bundle.
import { spawn } from "node:child_process";

function boots(name, args, env, ready) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env } });
    let output = "";
    const done = (ok) => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve({ name, ok, output });
    };
    const timer = setTimeout(() => done(false), 15_000);
    const onData = (data) => {
      output += data;
      if (ready.test(output)) done(true);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", () => done(ready.test(output)));
  });
}

const results = await Promise.all([
  boots(
    "bot",
    ["apps/bot/dist/main.js"],
    { OM_SERVER_WS: "ws://127.0.0.1:9/bot", OM_BOT_TOKEN: "smoke" },
    /bot iniciado/,
  ),
  boots("server CLI", ["apps/server/dist/main.js", "--version"], {}, /^\d+\.\d+\.\d+/m),
]);

let failed = false;
for (const { name, ok, output } of results) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name} bundle boots`);
  if (!ok) {
    failed = true;
    console.log(output.slice(-1500));
  }
}
process.exit(failed ? 1 : 0);
