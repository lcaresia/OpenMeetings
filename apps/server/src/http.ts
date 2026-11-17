import { timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import type { RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import type { Config } from "@open-meetings/config";
import type { exportArtifact, Logger } from "@open-meetings/core";
import { handleAguiRun } from "./agui";
import type { MeetingManager } from "./manager";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type RouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: () => Promise<unknown>;
  raw: () => Promise<Buffer>;
};

type Handler = (context: RouteContext) => Promise<unknown> | unknown;
type Route = { method: string; pattern: RegExp; keys: string[]; handler: Handler; raw?: boolean };

/** Fifty lines of routing instead of a framework. */
export class Router {
  private readonly routes: Route[] = [];

  add(method: string, path: string, handler: Handler, options: { raw?: boolean } = {}): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/:(\w+)/g, (_m, key: string) => {
        keys.push(key);
        return "([^/]+)";
      })}$`,
    );
    this.routes.push({ method, pattern, keys, handler, ...options });
    return this;
  }

  match(
    method: string,
    pathname: string,
  ): { route: Route; params: Record<string, string> } | undefined {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const found = route.pattern.exec(pathname);
      if (!found) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(found[i + 1] ?? "");
      });
      return { route, params };
    }
    return undefined;
  }
}

const MAX_BODY = 25 * 1024 * 1024;

export async function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "request body too large");
    parts.push(chunk as Buffer);
  }
  return Buffer.concat(parts);
}

export function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** True when the request carries the configured token (header, or `?token=` for downloads). */
export function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const url = new URL(req.url ?? "/", "http://localhost");
  const presented =
    req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token") ?? "";
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/** Serves the built panel; unknown paths fall back to index.html (client-side routing). */
export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): boolean {
  if (!existsSync(join(root, "index.html"))) return false;
  const url = new URL(req.url ?? "/", "http://localhost");
  const requested = normalize(join(root, decodeURIComponent(url.pathname)));
  const safe = requested.startsWith(resolve(root)) ? requested : join(root, "index.html");
  const file = existsSync(safe) && statSync(safe).isFile() ? safe : join(root, "index.html");
  const type = MIME[extname(file)] ?? "application/octet-stream";
  const immutable = file.includes(`${join(root, "assets")}`);
  res.writeHead(200, {
    "content-type": type,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
  });
  createReadStream(file).pipe(res);
  return true;
}

export type ApiDeps = {
  config: Config;
  manager: MeetingManager;
  logger: Logger;
  /** Runs `om doctor` against the active config. */
  doctor: () => Promise<unknown>;
  /** Extra routes (OpenAI-compatible endpoint, uploads). */
  extend?: (router: Router) => void;
};

/** Redacts every secret from the config before it leaves the server. */
export function redactConfig(config: Config): unknown {
  return JSON.parse(
    JSON.stringify(config, (key, value: unknown) =>
      /apikey|token|secret|password/i.test(key) && value
        ? "[redacted]"
        : key === "env" && value
          ? "[redacted]"
          : value,
    ),
  );
}

export function apiRouter(deps: ApiDeps): Router {
  const { manager, config } = deps;
  const router = new Router();
  const need = (value: unknown, message: string) => {
    if (!value) throw new HttpError(404, message);
    return value;
  };

  router
    .add("GET", "/api/health", () => ({ ok: true, live: manager.liveMeetings.length }))
    .add("GET", "/api/config", () => redactConfig(config))
    .add("GET", "/api/doctor", () => deps.doctor())
    .add("GET", "/api/meetings", ({ url }) => {
      const text = url.searchParams.get("q") ?? undefined;
      return manager.list({
        limit: Number(url.searchParams.get("limit") ?? 50),
        ...(text ? { text } : {}),
      });
    })
    .add("POST", "/api/meetings", async ({ body }) => {
      const input = (await body()) as { url?: string; title?: string };
      if (!input.url || !/^https?:\/\//.test(input.url))
        throw new HttpError(400, "a meeting link is required");
      const live = manager.start({
        url: input.url,
        ...(input.title ? { title: input.title } : {}),
      });
      return { id: live.record.id, status: live.record.status };
    })
    .add("GET", "/api/meetings/:id", ({ params }) => {
      const record = need(manager.get(params.id ?? ""), "meeting not found");
      return {
        ...(record as object),
        segments: manager.segments(params.id ?? ""),
        live: Boolean(manager.getLive(params.id ?? "")),
      };
    })
    .add("DELETE", "/api/meetings/:id", async ({ params }) => {
      need(await manager.delete(params.id ?? ""), "meeting not found");
      return { deleted: true };
    })
    .add("POST", "/api/meetings/:id/commands", async ({ params, body }) => {
      const input = (await body()) as { text?: string };
      if (!input.text?.trim()) throw new HttpError(400, "text is required");
      if (!manager.getLive(params.id ?? "")) throw new HttpError(409, "the meeting is not live");
      void manager.command(params.id ?? "", input.text.trim());
      return { accepted: true };
    })
    .add("POST", "/api/meetings/:id/approvals/:approval", async ({ params, body }) => {
      const input = (await body()) as { approved?: boolean };
      const ok = manager.resolveApproval(
        params.id ?? "",
        params.approval ?? "",
        input.approved === true,
      );
      need(ok, "no pending approval with this id");
      return { resolved: true };
    })
    .add("POST", "/api/meetings/:id/leave", ({ params }) => {
      need(manager.leave(params.id ?? ""), "the meeting is not live");
      return { leaving: true };
    })
    .add("GET", "/api/meetings/:id/artifacts", async ({ params }) =>
      manager.artifacts(params.id ?? ""),
    )
    .add("GET", "/api/artifacts/:id", async ({ params }) =>
      need(await manager.artifact(params.id ?? ""), "artifact not found"),
    )
    .add("GET", "/api/artifacts/:id/export", async ({ params, res, url }) => {
      const artifact = need(
        await manager.artifact(params.id ?? ""),
        "artifact not found",
      ) as Parameters<typeof exportArtifact>[0];
      const format = url.searchParams.get("format") ?? undefined;
      const file = await manager.exportArtifact(artifact, format);
      res.writeHead(200, {
        "content-type": file.mime,
        "content-disposition": `attachment; filename="${file.filename}"`,
      });
      res.end(file.body);
      return undefined;
    })
    .add("GET", "/api/meetings/:id/minutes", ({ params, res }) => {
      const record = manager.get(params.id ?? "");
      need(record?.minutes, "the minutes are written when the meeting ends");
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "content-disposition": `attachment; filename="minutes-${record?.startedAt.slice(0, 10)}.md"`,
      });
      res.end(record?.minutes);
      return undefined;
    })
    .add("GET", "/api/search", async ({ url }) => {
      const query = url.searchParams.get("q")?.trim();
      if (!query) throw new HttpError(400, "q is required");
      return manager.search(query, Number(url.searchParams.get("limit") ?? 10));
    })
    .add("POST", config.interop.agui.path, async ({ req, res, body }) => {
      const input = (await body()) as RunAgentInput;
      if (!input?.threadId || !input.runId)
        throw new HttpError(400, "threadId and runId are required");
      input.messages ??= [];
      input.tools ??= [];
      input.context ??= [];
      const encoder = new EventEncoder({ accept: req.headers.accept ?? "text/event-stream" });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const closed = new Promise<void>((resolve) => res.on("close", () => resolve()));
      // Keeps proxies from closing a quiet stream.
      const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
      try {
        await handleAguiRun(manager, {
          input,
          closed,
          emit: (event) => {
            if (!res.writableEnded) res.write(encoder.encode({ ...event, timestamp: Date.now() }));
          },
        });
      } finally {
        clearInterval(heartbeat);
        res.end();
      }
      return undefined;
    });

  deps.extend?.(router);
  return router;
}

/** The request listener: auth, API routes, then the static panel. */
export function createRequestHandler(deps: ApiDeps & { webRoot?: string }) {
  const router = apiRouter(deps);
  const token = deps.config.server.authToken;
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const matched = router.match(req.method ?? "GET", url.pathname);
    try {
      if (!matched) {
        if (req.method === "GET" && deps.webRoot && serveStatic(deps.webRoot, req, res)) return;
        throw new HttpError(404, "not found");
      }
      if (!authorized(req, token)) throw new HttpError(401, "missing or wrong token");
      let cached: Buffer | undefined;
      const raw = async () => {
        cached ??= await readBody(req);
        return cached;
      };
      const result = await matched.route.handler({
        req,
        res,
        url,
        params: matched.params,
        raw,
        body: async () => {
          const buffer = await raw();
          if (buffer.length === 0) return {};
          try {
            return JSON.parse(buffer.toString("utf8"));
          } catch {
            throw new HttpError(400, "body is not valid JSON");
          }
        },
      });
      if (result !== undefined && !res.headersSent) sendJson(res, 200, result);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500)
        deps.logger.error({ error: String(error), path: url.pathname }, "request failed");
      if (!res.headersSent)
        sendJson(res, status, {
          error: status === 500 ? "internal error" : (error as Error).message,
        });
      else res.end();
    }
  };
}
