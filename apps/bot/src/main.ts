#!/usr/bin/env node
import { createLogger, PROJECT_NAME } from "@open-meetings/core";
import { createMeetSource } from "./meet/meet-source";
import { BotWorker } from "./worker";

const logger = createLogger("bot");
const url = process.env.OM_SERVER_WS ?? "ws://127.0.0.1:4319/bot";
const token = process.env.OM_BOT_TOKEN;

if (!token) {
  logger.error("OM_BOT_TOKEN não definido: o bot precisa do mesmo token do servidor");
  process.exit(1);
}

const log = (message: string, extra: Record<string, unknown> = {}) => logger.info(extra, message);

const worker = new BotWorker({
  url,
  token,
  log,
  platforms: {
    meet: (meeting, options) => createMeetSource(meeting, options, { log }),
  },
});

worker.connect();
logger.info({ url }, `${PROJECT_NAME} bot iniciado`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void worker.close().finally(() => process.exit(0));
  });
}
