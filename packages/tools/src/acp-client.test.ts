import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acpAgentTools, runAcpTask } from "./acp-client";

const echo = {
  name: "codigo",
  command: process.execPath,
  args: [join(import.meta.dirname, "../test/echo-acp-agent.mjs")],
  env: {},
  autoApprove: false,
};

describe("ACP client", () => {
  it("runs a task on an ACP agent, allowing its permission request once", async () => {
    const answer = await runAcpTask(echo, "abrir issue: login falha no Safari");
    expect(answer).toBe("permission: yes. done: abrir issue: login falha no Safari");
  });

  it("exposes each configured agent as a tool that needs confirmation unless auto-approved", async () => {
    const [tool] = acpAgentTools([echo]);
    expect(tool).toMatchObject({ name: "agent_codigo", external: true });
    expect(tool?.summarize({ task: "abrir issue" })).toBe('pedir ao agente "codigo": abrir issue');
    expect(await tool?.run({ task: "x" }, {} as never)).toEqual({
      content: "permission: yes. done: x",
    });
    expect(acpAgentTools([{ ...echo, autoApprove: true }])[0]?.external).toBe(false);
  });

  it("reports an agent that cannot start", async () => {
    const [tool] = acpAgentTools([{ ...echo, command: "/nonexistent/agent" }]);
    expect(await tool?.run({ task: "x" }, {} as never)).toMatchObject({
      isError: true,
      content: expect.stringContaining("could not start"),
    });
  });
});
