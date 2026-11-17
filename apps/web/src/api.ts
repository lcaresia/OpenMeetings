export class UnauthorizedError extends Error {}

function readToken(): string | undefined {
  try {
    return localStorage.getItem("om.token") ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveToken(token: string): void {
  try {
    localStorage.setItem("om.token", token);
  } catch {
    // storage blocked: the token lasts for this page only
  }
  sessionToken = token;
}

let sessionToken = readToken();

const authHeaders = (): Record<string, string> =>
  sessionToken ? { authorization: `Bearer ${sessionToken}` } : {};

/** Link for downloads, which cannot carry a header. */
export const withToken = (path: string) =>
  sessionToken
    ? `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(sessionToken)}`
    : path;

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...authHeaders(), ...(init.headers ?? {}) },
  });
  if (res.status === 401) throw new UnauthorizedError("unauthorized");
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export type AguiEvent = { type: string } & Record<string, unknown>;

/**
 * One AG-UI run: POSTs a RunAgentInput to /agui and calls `onEvent` for every event of the
 * stream. Resolves when the run ends.
 */
export async function aguiRun(
  input: { threadId: string; messages?: unknown[]; resume?: unknown[]; forwardedProps?: unknown },
  onEvent: (event: AguiEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/agui", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", ...authHeaders() },
    body: JSON.stringify({
      runId: crypto.randomUUID(),
      messages: [],
      tools: [],
      context: [],
      ...input,
    }),
    ...(signal ? { signal } : {}),
  });
  if (res.status === 401) throw new UnauthorizedError("unauthorized");
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) onEvent(JSON.parse(line.slice(5).trim()) as AguiEvent);
      }
      end = buffer.indexOf("\n\n");
    }
  }
}
