import { isLocalUrl } from "@open-meetings/config";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class NetworkBlockedError extends Error {
  constructor(readonly url: string) {
    super(`Blocked outbound request to ${new URL(url).host}: this profile is local-only`);
    this.name = "NetworkBlockedError";
  }
}

export class EngineHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    body: string,
  ) {
    super(`HTTP ${status} from ${new URL(url).host}: ${body.slice(0, 300)}`);
    this.name = "EngineHttpError";
  }
}

/** Wraps fetch so that, in local-only mode, any non-private destination throws before connecting. */
export function guardedFetch(base: FetchLike, options: { localOnly: boolean }): FetchLike {
  if (!options.localOnly) return base;
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!isLocalUrl(url)) return Promise.reject(new NetworkBlockedError(url));
    return base(input, init);
  };
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

type PostOptions = { apiKey?: string; signal?: AbortSignal };

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

async function ensureOk(res: Response, url: string): Promise<Response> {
  if (res.ok) return res;
  throw new EngineHttpError(res.status, url, await res.text().catch(() => ""));
}

export async function postJson(
  fetchFn: FetchLike,
  url: string,
  body: unknown,
  options: PostOptions = {},
): Promise<Response> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(options.apiKey) },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  return ensureOk(res, url);
}

export async function postForm(
  fetchFn: FetchLike,
  url: string,
  form: FormData,
  options: PostOptions = {},
): Promise<Response> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: authHeaders(options.apiKey),
    body: form,
    signal: options.signal,
  });
  return ensureOk(res, url);
}
