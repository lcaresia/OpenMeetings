import { join } from "node:path";
import { HttpAgent } from "@ag-ui/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FixtureSource, loadFixture } from "@open-meetings/core";
import { createLiveSource, createScriptedLlm } from "@open-meetings/core/testing";
import { runAcpTask } from "@open-meetings/tools";
import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "./app";
import { aguiRun, collect, startTestApp } from "./testing";

const repo = join(import.meta.dirname, "../../..");
let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function liveWeekly(target: App) {
  const source = createLiveSource();
  const live = target.manager.start({ source, title: "Sync semanal" });
  source.join("ana", "Ana Souza");
  source.say("Ana Souza", "Então fica decidido que o lançamento será no dia 15 de dezembro.");
  source.say(
    "Ana Souza",
    "Bruno, você fica responsável por atualizar o contrato com o gateway até sexta-feira.",
  );
  return { source, live, id: live.record.id };
}

describe("AG-UI contract (official @ag-ui/client)", () => {
  it("rebuilds the server's exact state from STATE_SNAPSHOT + STATE_DELTA alone", async () => {
    app = await startTestApp();
    const fixture = loadFixture(join(repo, "fixtures/weekly-sync/captions.json"));
    const live = app.manager.start({
      source: new FixtureSource(fixture, { speed: 100 }),
      title: "Weekly",
    });
    const agent = new HttpAgent({ url: `${app.url}/agui`, threadId: live.record.id });
    const customs: string[] = [];
    await agent.runAgent({}, { onCustomEvent: ({ event }) => void customs.push(event.name) });
    await live.done;

    const server = app.manager.get(live.record.id)?.state;
    expect(server?.decisions.length).toBeGreaterThan(0);
    expect(agent.state).toEqual(server);
    expect(customs.filter((name) => name === "om.transcript").length).toBeGreaterThan(10);
    expect(customs).toContain("om.minutes");
  });
});

describe("AG-UI frontend tools", () => {
  it("lets the agent call a tool the client declared, and continues with its result", async () => {
    const smart = createScriptedLlm([
      { toolCalls: [{ name: "show_confetti", arguments: { color: "teal" } }] },
      (req) => {
        const result = req.messages.findLast((message) => message.role === "tool");
        return `Pronto: ${result?.content}.`;
      },
    ]);
    app = await startTestApp({ smart });
    const { source, id } = liveWeekly(app);
    const tools = [
      {
        name: "show_confetti",
        description: "Shows confetti on the user's screen",
        parameters: { type: "object", properties: { color: { type: "string" } } },
      },
    ];

    const first = await collect(
      aguiRun(app.url, {
        threadId: id,
        tools,
        messages: [{ id: "u1", role: "user", content: "comemora o lançamento na minha tela" }],
      }),
    );
    const call = first.find((event) => event.type === "TOOL_CALL_START");
    expect(call).toMatchObject({ toolCallName: "show_confetti" });
    expect(first.find((event) => event.type === "TOOL_CALL_ARGS")?.delta).toBe('{"color":"teal"}');
    expect(first.at(-1)).toMatchObject({
      type: "RUN_FINISHED",
      outcome: { type: "success", pendingToolCallIds: [call?.toolCallId] },
    });

    const second = await collect(
      aguiRun(app.url, {
        threadId: id,
        tools,
        messages: [
          { id: "u1", role: "user", content: "comemora o lançamento na minha tela" },
          { id: "t1", role: "tool", toolCallId: call?.toolCallId, content: "confetti shown" },
        ],
      }),
    );
    const text = second
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => event.delta)
      .join("");
    expect(text).toBe("Pronto: confetti shown.");
    expect(second.at(-1)?.type).toBe("RUN_FINISHED");
    source.end();
  });
});

describe("OpenAI-compatible endpoint (official openai SDK)", () => {
  it("lists the meeting models and streams an answer from the live meeting", async () => {
    app = await startTestApp();
    const { source } = liveWeekly(app);
    const client = new OpenAI({ baseURL: `${app.url}/v1`, apiKey: "not-needed" });

    const models = await client.models.list();
    expect(models.data.map((model) => model.id)).toEqual([
      "open-meetings/live",
      "open-meetings/history",
    ]);

    const stream = await client.chat.completions.create({
      model: "open-meetings/live",
      stream: true,
      messages: [{ role: "user", content: "quais são os itens de ação?" }],
    });
    let text = "";
    let finish: string | null | undefined;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta.content ?? "";
      finish = chunk.choices[0]?.finish_reason ?? finish;
    }
    expect(text).toContain("atualizar o contrato com o gateway");
    expect(finish).toBe("stop");
    source.end();
  });

  it("answers about past meetings without streaming", async () => {
    app = await startTestApp();
    const { source, live } = liveWeekly(app);
    source.end();
    await live.done;
    const client = new OpenAI({ baseURL: `${app.url}/v1`, apiKey: "not-needed" });
    const answer = await client.chat.completions.create({
      model: "open-meetings/history",
      messages: [{ role: "user", content: "o que ficou pendente?" }],
    });
    expect(answer.choices[0]?.message.content).toContain("atualizar o contrato com o gateway");
  });

  it("rejects unknown models with a useful message", async () => {
    app = await startTestApp();
    const client = new OpenAI({ baseURL: `${app.url}/v1`, apiKey: "x", maxRetries: 0 });
    await expect(
      client.chat.completions.create({
        model: "gpt-x",
        messages: [{ role: "user", content: "oi" }],
      }),
    ).rejects.toThrow(/unknown model gpt-x/);
  });
});

describe("MCP server (official MCP SDK client over Streamable HTTP)", () => {
  it("lets an MCP host read meetings and ask the live one", async () => {
    app = await startTestApp();
    const { source, id } = liveWeekly(app);
    const client = new Client({ name: "test-host", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${app.url}/mcp`)));

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "join_meeting",
      "list_meetings",
      "get_meeting",
      "ask_meeting",
      "search_meetings",
      "leave_meeting",
    ]);
    const text = (result: unknown) =>
      (result as { content: { text: string }[] }).content[0]?.text ?? "";

    const answer = text(
      await client.callTool({
        name: "ask_meeting",
        arguments: { question: "quais são os itens de ação?" },
      }),
    );
    expect(answer).toContain("atualizar o contrato com o gateway");

    // Asking folded what was said into the notes, so they are up to date now.
    const meeting = JSON.parse(
      text(await client.callTool({ name: "get_meeting", arguments: { meeting_id: id } })),
    );
    expect(meeting).toMatchObject({
      status: "live",
      decisions: [expect.stringContaining("15 de dezembro")],
    });

    const missing = await client.callTool({
      name: "get_meeting",
      arguments: { meeting_id: "nope" },
    });
    expect(missing.isError).toBe(true);
    await client.close();
    source.end();
  });
});

describe("om acp (Open Meetings as an ACP agent)", () => {
  const omAcp = (server: string) => ({
    name: "open-meetings",
    command: process.execPath,
    args: ["--import", "tsx", join(repo, "apps/server/src/cli/main.ts"), "acp", "--server", server],
    env: {},
    autoApprove: true,
  });

  it("answers about the live meeting over the official ACP SDK", async () => {
    app = await startTestApp();
    const { source } = liveWeekly(app);
    const answer = await runAcpTask(omAcp(app.url), "quais os itens de ação?", { cwd: repo });
    expect(answer).toContain("atualizar o contrato com o gateway");
    source.end();
  }, 30_000);

  it("answers about past meetings when nothing is live", async () => {
    app = await startTestApp();
    const { source, live } = liveWeekly(app);
    source.end();
    await live.done;
    const answer = await runAcpTask(omAcp(app.url), "o que ficou pendente da semana passada?", {
      cwd: repo,
    });
    expect(answer).toContain("Pendências");
    expect(answer).toContain("Sync semanal");
  }, 30_000);
});
