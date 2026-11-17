// A tiny MCP server over stdio, for tests: one read-only tool and one with side effects.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const cards = [];
const server = new Server({ name: "notes", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_cards",
      description: "List the cards on the board",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    },
    {
      name: "create_card",
      description: "Create a card on the board",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "list_cards") {
    return { content: [{ type: "text", text: cards.join("\n") || "(empty)" }] };
  }
  if (request.params.name === "create_card") {
    const title = request.params.arguments?.title;
    if (!title) return { content: [{ type: "text", text: "title is required" }], isError: true };
    cards.push(title);
    return { content: [{ type: "text", text: `created card "${title}"` }] };
  }
  return { content: [{ type: "text", text: "unknown tool" }], isError: true };
});

await server.connect(new StdioServerTransport());
