// A tiny ACP agent for tests: asks for permission once, then answers with the task it got.
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const app = acp.agent({ name: "echo" });
app
  .onRequest(acp.methods.agent.initialize, () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {},
    authMethods: [],
  }))
  .onRequest(acp.methods.agent.session.new, () => ({ sessionId: randomUUID() }))
  .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
    const task = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("");
    const permission = await client.request(acp.methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: { toolCallId: "t1", title: "Create the issue" },
      options: [
        { optionId: "yes", name: "Allow", kind: "allow_once" },
        { optionId: "always", name: "Always allow", kind: "allow_always" },
        { optionId: "no", name: "Reject", kind: "reject_once" },
      ],
    });
    const choice =
      permission.outcome.outcome === "selected" ? permission.outcome.optionId : "cancelled";
    for (const text of [`permission: ${choice}. `, `done: ${task}`]) {
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
    }
    return { stopReason: "end_turn" };
  });

app.connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
