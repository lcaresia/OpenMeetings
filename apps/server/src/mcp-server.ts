import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { PROJECT_SLUG, VERSION } from "@open-meetings/core";
import type { MeetingAssistant } from "./assistant";
import type { Router } from "./http";
import type { MeetingManager } from "./manager";

/**
 * Open Meetings as a remote MCP server (Streamable HTTP, stateless). This is how hosts that
 * extend themselves through MCP, such as OpenDots, Claude Desktop or IDEs, send the bot to a
 * meeting and read what happened in it. Tool names and texts are the public contract.
 */
const TOOLS = [
  {
    name: "join_meeting",
    description:
      "Send the Open Meetings bot to a meeting (Google Meet link). Returns the meeting id.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, title: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "list_meetings",
    description: "List recent meetings (live and past), newest first.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_meeting",
    description:
      "Notes of one meeting: status, decisions, action items with owner and due date, open questions, summary, and the minutes once it ended.",
    inputSchema: {
      type: "object",
      properties: { meeting_id: { type: "string" } },
      required: ["meeting_id"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "ask_meeting",
    description:
      "Ask the meeting agent. With a live meeting (the given one or the most recent), the question runs in that meeting; otherwise it is answered from past meetings.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string" }, meeting_id: { type: "string" } },
      required: ["question"],
    },
  },
  {
    name: "search_meetings",
    description:
      "Search every saved meeting by meaning. Returns matching passages with meeting and date.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "number" } },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "leave_meeting",
    description: "Take the bot out of a live meeting. The minutes are written when it leaves.",
    inputSchema: {
      type: "object",
      properties: { meeting_id: { type: "string" } },
      required: ["meeting_id"],
    },
  },
];

const text = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});
const failure = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});

function createServer(manager: MeetingManager, assistant: MeetingAssistant, panelUrl: string) {
  const server = new Server(
    { name: PROJECT_SLUG, version: VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const id = typeof args.meeting_id === "string" ? args.meeting_id : undefined;
    switch (request.params.name) {
      case "join_meeting": {
        if (typeof args.url !== "string") return failure("url is required");
        const live = manager.start({
          url: args.url,
          ...(typeof args.title === "string" ? { title: args.title } : {}),
        });
        return text({
          meeting_id: live.record.id,
          panel: `${panelUrl}/meetings/${live.record.id}`,
        });
      }
      case "list_meetings":
        return text(
          manager.list({ limit: Number(args.limit ?? 20) }).map((m) => ({
            meeting_id: m.id,
            title: m.title ?? m.state.title,
            status: m.status,
            started_at: m.startedAt,
            decisions: m.state.decisions.length,
            action_items: m.state.actionItems.length,
          })),
        );
      case "get_meeting": {
        const record = id ? manager.get(id) : undefined;
        if (!record) return failure(`No meeting with id ${id}`);
        const { state } = record;
        return text({
          meeting_id: record.id,
          title: record.title ?? state.title,
          status: record.status,
          started_at: record.startedAt,
          participants: state.participants.map((p) => p.name),
          decisions: state.decisions.map((d) => d.text),
          action_items: state.actionItems.map(({ text: item, owner, due, status }) => ({
            item,
            owner,
            due,
            status,
          })),
          open_questions: state.openQuestions.map((q) => q.text),
          summary: state.rollingSummary,
          ...(record.minutes ? { minutes: record.minutes } : {}),
          panel: `${panelUrl}/meetings/${record.id}`,
        });
      }
      case "ask_meeting": {
        if (typeof args.question !== "string") return failure("question is required");
        const liveId = assistant.liveMeetingId(id);
        let answer = "";
        const chunks = liveId
          ? assistant.askLive(liveId, args.question, "mcp")
          : assistant.askHistory([{ role: "user", content: args.question }]);
        for await (const chunk of chunks) answer += chunk;
        return text(answer.trim());
      }
      case "search_meetings": {
        if (typeof args.query !== "string") return failure("query is required");
        return text(await manager.search(args.query, Number(args.limit ?? 8)));
      }
      case "leave_meeting":
        return id && manager.leave(id)
          ? text("Leaving the meeting.")
          : failure("That meeting is not live.");
      default:
        return failure(`Unknown tool ${request.params.name}`);
    }
  });
  return server;
}

export function registerMcpServer(
  router: Router,
  options: {
    manager: MeetingManager;
    assistant: MeetingAssistant;
    path: string;
    panelUrl: () => string;
  },
): void {
  router.add("POST", options.path, async ({ req, res, body }) => {
    // Stateless: one server and transport per request, nothing to clean up between calls.
    const server = createServer(options.manager, options.assistant, options.panelUrl());
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, await body());
    return undefined;
  });
  // Stateless servers have no stream to resume or session to end.
  for (const method of ["GET", "DELETE"]) {
    router.add(method, options.path, ({ res }) => {
      res.writeHead(405, { allow: "POST" }).end();
      return undefined;
    });
  }
}
