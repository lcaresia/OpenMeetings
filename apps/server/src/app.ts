import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import type { LoadedConfig } from "@open-meetings/config";
import { createLogger, type Engines, type Logger } from "@open-meetings/core";
import { createEngines, type FetchLike } from "@open-meetings/engines";
import { connectMcpServers, type Tool } from "@open-meetings/tools";
import { BotHub } from "./bot-hub";
import { runDoctor } from "./cli/doctor";
import { createRequestHandler, type Router } from "./http";
import { MeetingManager } from "./manager";
import { openSqliteStore } from "./storage/sqlite";
import type { MeetingStore } from "./storage/store";

export type AppOptions = {
  /** Replaces the engines from the config (tests). */
  engines?: Engines;
  store?: MeetingStore;
  fetch?: FetchLike;
  logger?: Logger;
  /** Port 0 picks a free port. */
  port?: number;
  webRoot?: string;
  extraTools?: Tool[];
  /** Extra HTTP routes. */
  extend?: (router: Router, manager: MeetingManager) => void;
  /** Disable the bot (no meetings by link): tests and the ACP/CLI helpers. */
  noBot?: boolean;
};

export type App = {
  server: Server;
  manager: MeetingManager;
  store: MeetingStore;
  url: string;
  botToken: string;
  close(): Promise<void>;
};

/** Where the built panel lives: next to the bundle when published, apps/web/dist in the repo. */
function findWebRoot(): string | undefined {
  const here = import.meta.dirname;
  return [join(here, "web"), join(here, "../../web/dist"), resolve("apps/web/dist")].find((dir) =>
    existsSync(join(dir, "index.html")),
  );
}

function findBotEntry(): string | undefined {
  const candidates = [
    process.env.OM_BOT_ENTRY,
    join(import.meta.dirname, "../../bot/dist/main.js"),
    join(import.meta.dirname, "../../../bot/dist/main.js"),
    resolve("apps/bot/dist/main.js"),
  ];
  return candidates.find((path): path is string => Boolean(path && existsSync(path)));
}

export async function startApp(loaded: LoadedConfig, options: AppOptions = {}): Promise<App> {
  const { config } = loaded;
  const logger = options.logger ?? createLogger("server");
  const store =
    options.store ??
    (config.storage.driver === "sqlite" ? await openSqliteStore(config.storage.path) : undefined);
  if (!store)
    throw new Error("storage.driver postgres is not available yet; use sqlite (ADR 0004)");
  const engines =
    options.engines ?? createEngines(config, options.fetch ? { fetch: options.fetch } : {});

  const mcp = await connectMcpServers(config.mcp.servers);
  for (const failure of mcp.failures) logger.warn(failure, "MCP server did not start");

  const botToken = config.bot.token ?? process.env.OM_BOT_TOKEN ?? randomBytes(24).toString("hex");
  let worker: ChildProcess | undefined;
  let serverUrl = "";
  const hub = new BotHub({
    token: botToken,
    workerTimeoutMs: 60_000,
    spawnWorker: () => {
      if (!config.bot.spawn || worker) return;
      const entry = findBotEntry();
      if (!entry) {
        logger.error("bot entry not found (build apps/bot or set OM_BOT_ENTRY)");
        return;
      }
      // A .ts entry (development, tests) runs through tsx.
      const args = entry.endsWith(".ts") ? ["--import", "tsx", entry] : [entry];
      worker = spawn(process.execPath, args, {
        env: {
          ...process.env,
          OM_SERVER_WS: `${serverUrl.replace(/^http/, "ws")}/bot`,
          OM_BOT_TOKEN: botToken,
        },
        stdio: ["ignore", "inherit", "inherit"],
      });
      worker.on("exit", (code) => {
        logger.warn({ code }, "bot process exited");
        worker = undefined;
      });
    },
  });

  const manager = new MeetingManager({
    config,
    engines,
    store,
    logger,
    tools: [...mcp.tools, ...(options.extraTools ?? [])],
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.noBot ? {} : { botSource: () => hub.createSource(botJoinOptions(config)) }),
  });

  const webRoot = options.webRoot ?? findWebRoot();
  const handler = createRequestHandler({
    config,
    manager,
    logger,
    doctor: () => runDoctor(loaded, options.fetch ? { fetch: options.fetch } : {}),
    ...(webRoot ? { webRoot } : {}),
    extend: (router) => options.extend?.(router, manager),
  });
  const server = createServer((req, res) => void handler(req, res));
  if (!options.noBot) hub.attach(server);

  await new Promise<void>((resolveListen) =>
    server.listen(options.port ?? config.server.port, config.server.host, resolveListen),
  );
  const address = server.address() as AddressInfo;
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  serverUrl = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${address.port}`;

  const retention = setInterval(() => {
    const removed = manager.purgeExpired();
    if (removed) logger.info({ removed }, "expired meetings deleted");
  }, 6 * 3_600_000);
  manager.purgeExpired();

  return {
    server,
    manager,
    store,
    url: serverUrl,
    botToken,
    async close() {
      clearInterval(retention);
      await manager.shutdown();
      hub.close();
      worker?.kill("SIGTERM");
      await mcp.close();
      await new Promise((resolveClose) => server.close(resolveClose));
      server.closeAllConnections();
      store.close();
    },
  };
}

export function botJoinOptions(config: LoadedConfig["config"]) {
  return {
    displayName: config.bot.displayName,
    headless: config.bot.headless,
    captureAudio: config.bot.captureAudio,
    admissionTimeoutSec: config.bot.admissionTimeoutSec,
    ...(config.bot.storageState ? { storageState: config.bot.storageState } : {}),
    ...(config.bot.captionsLanguage ? { captionsLanguage: config.bot.captionsLanguage } : {}),
  };
}
