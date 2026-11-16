import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "@open-meetings/config";
import { PROJECT_SLUG, VERSION } from "@open-meetings/core";
import type { Tool } from "./types";

export type McpConnection = {
  tools: Tool[];
  /** Servers that failed to start, with the reason. The others keep working. */
  failures: { server: string; error: string }[];
  close(): Promise<void>;
};

type McpContent = { type: string; text?: string };

const safeName = (text: string) => text.replace(/[^a-zA-Z0-9_-]/g, "_");

/**
 * Starts the configured MCP servers (stdio) and exposes their tools to the agent.
 *
 * An MCP tool is treated as acting outside the meeting, so it waits for a person's
 * confirmation, unless the server marks it read-only or the config lists it in `autoApprove`.
 */
export async function connectMcpServers(servers: McpServerConfig[]): Promise<McpConnection> {
  const clients: Client[] = [];
  const tools: Tool[] = [];
  const failures: McpConnection["failures"] = [];

  for (const server of servers) {
    try {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries({ ...process.env, ...server.env })) {
        if (value !== undefined) env[key] = value;
      }
      const client = new Client({ name: PROJECT_SLUG, version: VERSION });
      await client.connect(
        new StdioClientTransport({
          command: server.command,
          args: server.args,
          env,
          stderr: "ignore",
        }),
      );
      clients.push(client);
      const listed = await client.listTools();
      const approveAll = server.autoApprove.includes("*");

      for (const remote of listed.tools) {
        const readOnly = remote.annotations?.readOnlyHint === true;
        tools.push({
          name: safeName(`${server.name}__${remote.name}`).slice(0, 64),
          description: remote.description ?? `${remote.name} (from the ${server.name} MCP server)`,
          parameters: remote.inputSchema as Record<string, unknown>,
          // The server validates its own arguments; pass them through.
          parse: (args) => args ?? {},
          external: !(readOnly || approveAll || server.autoApprove.includes(remote.name)),
          summarize: (args) =>
            `${server.name}: ${remote.name} ${JSON.stringify(args).slice(0, 200)}`,
          async run(args) {
            const result = await client.callTool({
              name: remote.name,
              arguments: args as Record<string, unknown>,
            });
            const content = (result.content as McpContent[] | undefined) ?? [];
            const text = content
              .map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
              .join("\n");
            return { content: text || "(no output)", ...(result.isError ? { isError: true } : {}) };
          },
        });
      }
    } catch (error) {
      failures.push({
        server: server.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    tools,
    failures,
    async close() {
      await Promise.allSettled(clients.map((client) => client.close()));
    },
  };
}
