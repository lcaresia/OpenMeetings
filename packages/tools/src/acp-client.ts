import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AcpAgentConfig } from "@open-meetings/config";
import { PROJECT_SLUG, VERSION } from "@open-meetings/core";
import { z } from "zod";
import { defineTool, type Tool } from "./types";

const safeName = (text: string) => text.toLowerCase().replace(/[^a-z0-9_-]/g, "_");

/**
 * Runs one task on an external ACP agent (OpenCode, Claude Code, Codex, Gemini CLI...) and
 * returns what it answered. The process lives only for this task.
 *
 * The people in the meeting already confirmed the delegation itself, so permission requests the
 * agent makes along the way are answered "allow once"; `allow always` is never chosen.
 */
export async function runAcpTask(
  agent: AcpAgentConfig,
  task: string,
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...agent.env })) {
    if (value !== undefined) env[key] = value;
  }
  const child = spawn(agent.command, agent.args, {
    env,
    stdio: ["pipe", "pipe", "ignore"],
    cwd: options.cwd,
  });
  const exited = new Promise<never>((_resolve, reject) => {
    child.on("error", (error) =>
      reject(new Error(`could not start ${agent.command}: ${error.message}`)),
    );
    child.on("exit", (code) =>
      reject(new Error(`${agent.name} exited (code ${code}) before answering`)),
    );
  });
  const timeout = new Promise<never>((_resolve, reject) =>
    setTimeout(
      () => reject(new Error(`${agent.name} did not finish in time`)),
      options.timeoutMs ?? 10 * 60_000,
    ).unref(),
  );

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const client = acp
    .client({ name: PROJECT_SLUG })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      const allow = params.options.find((option) => option.kind === "allow_once");
      return allow
        ? { outcome: { outcome: "selected" as const, optionId: allow.optionId } }
        : { outcome: { outcome: "cancelled" as const } };
    });

  const work = client.connectWith(stream, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: PROJECT_SLUG, version: VERSION },
    });
    return ctx.buildSession(options.cwd ?? process.cwd()).withSession(async (session) => {
      const answer = session.prompt(task);
      let text = "";
      for (;;) {
        const message = await session.nextUpdate();
        if (message.kind === "stop") break;
        const { update } = message;
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text")
          text += update.content.text;
      }
      const response = await answer;
      return response.stopReason === "end_turn"
        ? text.trim()
        : `${text.trim()}\n(stopped: ${response.stopReason})`;
    });
  });

  try {
    return await Promise.race([work, exited, timeout]);
  } finally {
    child.kill();
  }
}

/** One tool per configured ACP agent. Delegating always asks first unless `autoApprove`. */
export function acpAgentTools(agents: AcpAgentConfig[], options: { cwd?: string } = {}): Tool[] {
  return agents.map((agent) =>
    defineTool({
      name: `agent_${safeName(agent.name)}`,
      description:
        `Hand a task to the external agent "${agent.name}" (${agent.command}) and get its answer. ` +
        `Use it when someone asks to have "${agent.name}" (or a coding agent) do something: open an issue, ` +
        "change code, investigate a bug. The agent does not see the meeting, so write a complete task.",
      schema: z.object({
        task: z
          .string()
          .min(1)
          .describe("The full task, self-contained, with every detail from the meeting it needs."),
      }),
      external: !agent.autoApprove,
      summarize: (args) => `pedir ao agente "${agent.name}": ${args.task.slice(0, 200)}`,
      run: async (args) => {
        try {
          const answer = await runAcpTask(agent, args.task, options);
          return { content: answer || `${agent.name} finished without a written answer.` };
        } catch (error) {
          return { content: (error as Error).message, isError: true };
        }
      },
    }),
  );
}
