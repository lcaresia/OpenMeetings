import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import {
  applyPatch,
  emptyState,
  type MeetingState,
  PROJECT_NAME,
  PROJECT_SLUG,
  VERSION,
} from "@open-meetings/core";

/**
 * `om acp`: Open Meetings as an ACP agent (JSON-RPC over stdio), so ACP clients such as OpenBot
 * or Zed can add it as an agent. It is a thin client of a running `om serve`: meetings live in
 * the server, this process only translates.
 *
 * In a session you can paste a meeting link (the bot joins and live updates arrive as session
 * notifications), ask about the live meeting, ask about past meetings, or ask for the minutes.
 */

type Session = { meetingId?: string; follow?: AbortController; prompt?: AbortController };

const LINK =
  /https?:\/\/(meet\.google\.com|[\w.-]*zoom\.us|teams\.microsoft\.com|teams\.live\.com|meet\.jit\.si)\/\S+/i;
const MINUTES = /\b(ata|minutes|resumo final|final summary)\b/i;

export type AcpAgentOptions = {
  server: string;
  token?: string;
  input?: ReadableStream<Uint8Array>;
  output?: WritableStream<Uint8Array>;
};

export function createAcpAgent(options: AcpAgentOptions) {
  const base = options.server.replace(/\/$/, "");
  const headers = (extra: Record<string, string> = {}) => ({
    "content-type": "application/json",
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...extra,
  });
  const sessions = new Map<string, Session>();

  async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${base}${path}`, { ...init, headers: headers() });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `server answered HTTP ${res.status}`);
    return body;
  }

  /** Reads an SSE response and yields each `data:` payload. */
  async function* events(res: Response): AsyncGenerator<string> {
    if (!res.body) return;
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        for (const line of buffer.slice(0, end).split("\n"))
          if (line.startsWith("data:")) yield line.slice(5).trim();
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\n\n");
      }
    }
  }

  const app = acp.agent({ name: PROJECT_SLUG });

  /** Live meeting activity, sent as session updates while the meeting runs. */
  async function follow(
    client: acp.AgentContext,
    sessionId: string,
    meetingId: string,
    signal: AbortSignal,
  ) {
    const say = (text: string) =>
      client.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
    let state: MeetingState = emptyState();
    try {
      const res = await fetch(`${base}/agui`, {
        method: "POST",
        headers: headers({ accept: "text/event-stream" }),
        body: JSON.stringify({
          threadId: meetingId,
          runId: randomUUID(),
          messages: [],
          tools: [],
          context: [],
        }),
        signal,
      });
      for await (const data of events(res)) {
        const event = JSON.parse(data) as {
          type: string;
          snapshot?: MeetingState;
          delta?: never;
          name?: string;
          value?: Record<string, unknown>;
        };
        if (event.type === "STATE_SNAPSHOT" && event.snapshot) state = event.snapshot;
        else if (event.type === "STATE_DELTA" && event.delta) {
          const next = applyPatch(state, event.delta);
          for (const decision of next.decisions.slice(state.decisions.length))
            await say(`\nDecision: ${decision.text}`);
          for (const item of next.actionItems.slice(state.actionItems.length)) {
            await say(
              `\nAction item: ${item.text}${item.owner ? ` (${item.owner}${item.due ? `, ${item.due}` : ""})` : ""}`,
            );
          }
          state = next;
        } else if (
          event.type === "CUSTOM" &&
          event.name === "om.status" &&
          event.value?.status === "left"
        ) {
          await say("\nThe meeting has ended. Ask for the minutes to get them.");
        }
      }
    } catch {
      // the meeting ended, the session closed, or the server went away
    }
  }

  async function streamCompletion(
    model: string,
    text: string,
    meetingId: string | undefined,
    say: (text: string) => Promise<void>,
    signal: AbortSignal,
  ) {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model,
        stream: true,
        messages: [{ role: "user", content: text }],
        ...(meetingId ? { meeting_id: meetingId } : {}),
      }),
      signal,
    });
    if (!res.ok) throw new Error(`server answered HTTP ${res.status}: ${await res.text()}`);
    for await (const data of events(res)) {
      if (data === "[DONE]") break;
      const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string } }[] };
      const piece = chunk.choices?.[0]?.delta?.content;
      if (piece) await say(piece);
    }
  }

  app
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      agentInfo: { name: PROJECT_SLUG, title: PROJECT_NAME, version: VERSION },
      authMethods: [],
    }))
    .onRequest(acp.methods.agent.session.new, () => {
      const sessionId = randomUUID();
      sessions.set(sessionId, {});
      return { sessionId };
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const session = sessions.get(params.sessionId) ?? {};
      sessions.set(params.sessionId, session);
      const controller = new AbortController();
      session.prompt = controller;
      const say = (text: string) =>
        client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        });
      const text = params.prompt
        .map((block) =>
          block.type === "text" ? block.text : block.type === "resource_link" ? block.uri : "",
        )
        .join("\n")
        .trim();

      try {
        const link = LINK.exec(text)?.[0];
        if (link) {
          const started = await api<{ id: string }>("/api/meetings", {
            method: "POST",
            body: JSON.stringify({ url: link }),
          });
          session.follow?.abort();
          session.meetingId = started.id;
          session.follow = new AbortController();
          void follow(client, params.sessionId, started.id, session.follow.signal);
          await say(
            `Sending the bot to the meeting. Live panel: ${base}/meetings/${started.id}\nI will post decisions and action items here as they come.`,
          );
          return { stopReason: "end_turn" };
        }

        const meeting = session.meetingId
          ? await api<{ live: boolean; minutes?: string }>(`/api/meetings/${session.meetingId}`)
          : undefined;
        if (MINUTES.test(text) && meeting && !meeting.live) {
          await say(meeting.minutes ?? "The minutes are not ready yet.");
          return { stopReason: "end_turn" };
        }
        const live =
          meeting?.live || (!meeting && (await api<{ live: number }>("/api/health")).live > 0);
        await streamCompletion(
          live ? "open-meetings/live" : "open-meetings/history",
          text,
          meeting?.live ? session.meetingId : undefined,
          say,
          controller.signal,
        );
        return { stopReason: controller.signal.aborted ? "cancelled" : "end_turn" };
      } catch (error) {
        if (controller.signal.aborted) return { stopReason: "cancelled" };
        await say(`Could not reach Open Meetings at ${base}: ${(error as Error).message}`);
        return { stopReason: "end_turn" };
      }
    })
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
      sessions.get(params.sessionId)?.prompt?.abort();
    });

  return {
    app,
    connect() {
      const stream = acp.ndJsonStream(
        options.output ?? (Writable.toWeb(process.stdout) as WritableStream<Uint8Array>),
        options.input ?? (Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>),
      );
      const connection = app.connect(stream);
      return connection.closed.finally(() => {
        for (const session of sessions.values()) session.follow?.abort();
      });
    },
  };
}
