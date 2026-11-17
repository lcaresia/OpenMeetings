import { join } from "node:path";
import {
  DEFAULT_SESSION_OPTIONS,
  exportArtifact,
  MeetingSession,
  MemoryArtifactStore,
  type SessionEvent,
} from "@open-meetings/core";
import {
  createLiveSource,
  createRuleLlm,
  createScriptedLlm,
  type ScriptedTurn,
} from "@open-meetings/core/testing";
import { withJsonToolFallback } from "@open-meetings/engines";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createAgent, shortenForChat } from "./agent";
import { builtinTools } from "./builtin";
import { connectMcpServers, type McpConnection } from "./mcp";
import { defineTool, type Tool } from "./types";

/** A live meeting where the agent runs the given script for every request. */
function meeting(
  turns: ScriptedTurn[],
  extraTools: Tool[] = [],
  options: { maxSteps?: number } = {},
) {
  const source = createLiveSource();
  const fast = createRuleLlm();
  const smart = createScriptedLlm(turns);
  const artifacts = new MemoryArtifactStore();
  const agent = createAgent({
    llm: smart,
    tools: [...builtinTools({ webFetch: false }), ...extraTools],
    artifacts,
    maxSteps: options.maxSteps ?? 8,
  });
  const session = new MeetingSession(
    source,
    { id: "m1", platform: "test" },
    { fast, smart },
    { ...DEFAULT_SESSION_OPTIONS, today: "2026-11-16" },
    agent,
  );
  const events: SessionEvent[] = [];
  session.on((event) => events.push(event));
  const done = session.run();
  return { source, session, events, artifacts, smart, done };
}

describe("agent", () => {
  it("creates a document with a tool, lists it in the state and answers in the chat", async () => {
    const m = meeting([
      {
        text: "",
        toolCalls: [
          {
            name: "create_doc",
            arguments: { title: "Plano de lançamento", markdown: "# Plano\n\n- Lançar dia 15" },
          },
        ],
      },
      "Criei o documento Plano de lançamento no painel.",
    ]);
    m.source.join("ana", "Ana");
    m.source.say("Ana", "Então fica decidido que lançamos dia 15.");
    m.source.say("Ana", "Open Meetings, escreve um plano de lançamento.");
    const reply = await m.source.waitForChat("Criei o documento");
    m.source.end();
    await m.done;

    expect(reply).toBe("Criei o documento Plano de lançamento no painel.");
    const [artifact] = m.session.pipeline.state.artifacts;
    expect(artifact).toMatchObject({ type: "doc", title: "Plano de lançamento" });
    const stored = await m.artifacts.get(artifact?.id ?? "");
    expect(stored?.content).toEqual({ type: "doc", markdown: "# Plano\n\n- Lançar dia 15" });

    // The model was shown the notes, which already held the decision said just before.
    const shown = m.smart.calls[0]?.messages[1]?.content ?? "";
    expect(shown).toContain("lançamos dia 15");
    expect(shown).toContain("escreve um plano de lançamento");
    expect(m.smart.calls[0]?.tools?.map((tool) => tool.name)).toEqual([
      "create_doc",
      "create_sheet",
      "create_board",
      "create_timeline",
      "search_past_meetings",
    ]);

    const kinds = m.events.map((event) => event.type);
    for (const kind of ["run_started", "tool_call", "tool_result", "run_finished"])
      expect(kinds).toContain(kind);
    expect(m.events.some((event) => event.type === "usage" && event.tier === "smart")).toBe(true);
  });

  it("updates an artifact it created before instead of making a new one", async () => {
    let docId = "";
    const m = meeting([
      {
        toolCalls: [
          {
            name: "create_sheet",
            arguments: { title: "Custos", columns: ["item", "valor"], rows: [["API", 10]] },
          },
        ],
      },
      "Planilha criada.",
      (req) => {
        docId = JSON.parse(
          req.messages[1]?.content.split("MEETING STATE:\n")[1]?.split("\n\n")[0] ?? "{}",
        ).artifacts[0].id;
        return {
          toolCalls: [
            {
              name: "create_sheet",
              arguments: {
                id: docId,
                title: "Custos",
                columns: ["item", "valor"],
                rows: [
                  ["API", 10],
                  ["VPS", 5, "extra"],
                ],
              },
            },
          ],
        };
      },
      "Planilha atualizada.",
    ]);
    m.source.chat("Ana", "om crie uma planilha de custos");
    await m.source.waitForChat("Planilha criada");
    m.source.chat("Ana", "om acrescenta a VPS");
    await m.source.waitForChat("Planilha atualizada");
    m.source.end();
    await m.done;

    expect(m.session.pipeline.state.artifacts).toHaveLength(1);
    const sheet = await m.artifacts.get(docId);
    // Rows are padded or cut to the number of columns.
    expect(sheet?.content).toEqual({
      type: "sheet",
      columns: ["item", "valor"],
      rows: [
        ["API", 10],
        ["VPS", 5],
      ],
    });
    expect(exportArtifact(sheet ?? (undefined as never)).body).toBe("item,valor\nAPI,10\nVPS,5");
  });

  it("hands invalid arguments back to the model, which can correct itself", async () => {
    const m = meeting([
      {
        toolCalls: [
          {
            name: "create_timeline",
            arguments: {
              title: "Cronograma",
              tasks: [{ name: "Contrato", start: "sexta", end: "2026-11-20" }],
            },
          },
        ],
      },
      (req) => {
        const error = req.messages.findLast((message) => message.role === "tool");
        expect(error).toMatchObject({ isError: true });
        expect(error?.content).toContain("YYYY-MM-DD");
        return {
          toolCalls: [
            {
              name: "create_timeline",
              arguments: {
                title: "Cronograma",
                tasks: [
                  { name: "Contrato", owner: "Bruno", start: "2026-11-20", end: "2026-11-18" },
                ],
              },
            },
          ],
        };
      },
      "Cronograma criado.",
    ]);
    m.source.chat("Ana", "om crie um cronograma");
    await m.source.waitForChat("Cronograma criado");
    m.source.end();
    await m.done;
    const timeline = await m.artifacts.list("m1");
    // An end before the start is fixed, not refused.
    expect(timeline[0]?.content).toMatchObject({
      tasks: [{ start: "2026-11-18", end: "2026-11-18" }],
    });
  });

  it("stops after maxSteps even if the model keeps calling tools", async () => {
    const m = meeting(
      [{ toolCalls: [{ name: "search_past_meetings", arguments: { query: "x" } }] }],
      [],
      { maxSteps: 3 },
    );
    m.source.chat("Ana", "om procure em reuniões anteriores");
    await m.source.waitForChat("Não consegui");
    m.source.end();
    await m.done;
    expect(m.smart.calls).toHaveLength(3);
    // No search engine configured: the tool says so instead of failing silently.
    const result = m.events.find((event) => event.type === "tool_result");
    expect(result).toMatchObject({
      isError: true,
      content: expect.stringContaining("not configured"),
    });
  });

  it("keeps long answers out of the call chat", () => {
    const long = `${"Uma frase longa sobre o projeto. ".repeat(40)}Fim.`;
    const short = shortenForChat(long, "pt-BR");
    expect(short.length).toBeLessThan(600);
    expect(short).toContain("(resposta completa no painel)");
    expect(shortenForChat("curta", "pt-BR")).toBe("curta");
  });
});

describe("actions outside the meeting", () => {
  let created: string[] = [];
  const createCard = defineTool({
    name: "trello_create_card",
    description: "Create a Trello card",
    schema: z.object({ title: z.string() }),
    external: true,
    summarize: (args) => `criar o card "${args.title}" no Trello`,
    run: async (args) => {
      created.push(args.title);
      return { content: `created ${args.title}` };
    },
  });
  afterEach(() => {
    created = [];
  });

  const script: ScriptedTurn[] = [
    { toolCalls: [{ name: "trello_create_card", arguments: { title: "Revisar contrato" } }] },
    (req) =>
      req.messages.at(-1)?.content.includes("did not confirm")
        ? "Ok, não criei o card."
        : "Card criado.",
  ];

  it("waits for om sim before running the tool", async () => {
    const m = meeting(script, [createCard]);
    m.source.join("ana", "Ana", false);
    m.source.chat("Ana", "om cria um card para revisar o contrato");
    const question = await m.source.waitForChat("Preciso de confirmação");
    expect(question).toContain('criar o card "Revisar contrato" no Trello');
    expect(created).toEqual([]);
    m.source.chat("Ana", "om sim");
    await m.source.waitForChat("Card criado");
    m.source.end();
    await m.done;
    expect(created).toEqual(["Revisar contrato"]);
    expect(m.events.find((event) => event.type === "approval_resolved")).toMatchObject({
      approved: true,
      by: "Ana",
    });
  });

  it("does nothing on om não, and tells the model", async () => {
    const m = meeting(script, [createCard]);
    m.source.chat("Ana", "om cria um card para revisar o contrato");
    await m.source.waitForChat("Preciso de confirmação");
    m.source.chat("Ana", "om não");
    await m.source.waitForChat("não criei");
    m.source.end();
    await m.done;
    expect(created).toEqual([]);
  });

  it("ignores an approval typed by a guest from outside the organization", async () => {
    const m = meeting(script, [createCard]);
    m.source.join("guest", "Cliente", true);
    m.source.join("ana", "Ana", false);
    m.source.chat("Ana", "om cria um card para revisar o contrato");
    await m.source.waitForChat("Preciso de confirmação");
    m.source.chat("Cliente", "om sim");
    m.source.chat("Ana", "om não");
    await m.source.waitForChat("não criei");
    m.source.end();
    await m.done;
    expect(created).toEqual([]);
    expect(m.events.find((event) => event.type === "approval_resolved")).toMatchObject({
      approved: false,
      by: "Ana",
    });
  });

  it("refuses everything still pending when the meeting ends", async () => {
    const m = meeting(script, [createCard]);
    m.source.chat("Ana", "om cria um card para revisar o contrato");
    await m.source.waitForChat("Preciso de confirmação");
    m.session.leave("test");
    await m.done;
    expect(created).toEqual([]);
  });
});

describe("JSON tool fallback", () => {
  const tools = builtinTools({ webFetch: false }).map(({ name, description, parameters }) => ({
    name,
    description,
    parameters,
  }));

  it("turns a JSON answer into tool calls and validates the tool name, with one retry", async () => {
    const base = createScriptedLlm(
      [
        '{"tool_calls":[{"name":"make_coffee","arguments":{}}]}',
        'Claro: {"tool_calls":[{"name":"create_doc","arguments":{"title":"Ata","markdown":"# Ata"}}]}',
      ],
      { nativeTools: false },
    );
    const engine = withJsonToolFallback(base);
    const deltas = [];
    for await (const delta of engine.chat({
      messages: [{ role: "user", content: "crie a ata" }],
      tools,
    }))
      deltas.push(delta);

    expect(deltas.filter((d) => d.type === "tool_call")).toMatchObject([
      { call: { name: "create_doc", arguments: '{"title":"Ata","markdown":"# Ata"}' } },
    ]);
    expect(deltas.at(-1)).toEqual({ type: "done", finishReason: "tool_calls" });
    expect(base.calls).toHaveLength(2);
    expect(base.calls[1]?.messages.at(-1)?.content).toContain("unknown tool: make_coffee");
    expect(base.calls[0]?.json).toBe(true);
    expect(base.calls[0]?.tools).toBeUndefined();
  });

  it("runs the whole agent loop on a model without native tools", async () => {
    const base = createScriptedLlm(
      [
        '{"tool_calls":[{"name":"create_board","arguments":{"title":"Quadro","columns":[{"title":"A fazer","cards":["Contrato"]}]}}]}',
        (req) => {
          // Tool traffic is shown to this model as plain text.
          expect(req.messages.some((message) => message.role === "tool")).toBe(false);
          expect(req.messages.some((message) => message.content.startsWith("TOOL RESULT"))).toBe(
            true,
          );
          return '{"answer":"Quadro criado."}';
        },
      ],
      { nativeTools: false },
    );
    const source = createLiveSource();
    const artifacts = new MemoryArtifactStore();
    const fast = createRuleLlm();
    const smart = withJsonToolFallback(base);
    const session = new MeetingSession(
      source,
      { id: "m2", platform: "test" },
      { fast, smart },
      DEFAULT_SESSION_OPTIONS,
      createAgent({ llm: smart, tools: builtinTools({ webFetch: false }), artifacts, maxSteps: 4 }),
    );
    const done = session.run();
    source.chat("Ana", "om crie um quadro");
    expect(await source.waitForChat("Quadro")).toBe("Quadro criado.");
    source.end();
    await done;
    expect((await artifacts.list("m2"))[0]?.content.type).toBe("board");
  });
});

describe("MCP client", () => {
  let connection: McpConnection | undefined;
  afterEach(async () => {
    await connection?.close();
    connection = undefined;
  });

  it("exposes the tools of an MCP server, and asks before the ones with side effects", async () => {
    connection = await connectMcpServers([
      {
        name: "notes",
        command: process.execPath,
        args: [join(import.meta.dirname, "../test/notes-mcp-server.mjs")],
        env: {},
        autoApprove: [],
      },
      { name: "broken", command: "/nonexistent/mcp-server", args: [], env: {}, autoApprove: [] },
    ]);
    expect(connection.failures.map((failure) => failure.server)).toEqual(["broken"]);
    const byName = Object.fromEntries(connection.tools.map((tool) => [tool.name, tool]));
    expect(Object.keys(byName).sort()).toEqual(["notes__create_card", "notes__list_cards"]);
    expect(byName.notes__list_cards?.external).toBe(false);
    expect(byName.notes__create_card?.external).toBe(true);

    const context = {} as never;
    expect(await byName.notes__create_card?.run({ title: "Contrato" }, context)).toEqual({
      content: 'created card "Contrato"',
    });
    expect(await byName.notes__list_cards?.run({}, context)).toEqual({ content: "Contrato" });
    expect(await byName.notes__create_card?.run({}, context)).toEqual({
      content: "title is required",
      isError: true,
    });
  });

  it("skips confirmation for tools listed in autoApprove", async () => {
    connection = await connectMcpServers([
      {
        name: "notes",
        command: process.execPath,
        args: [join(import.meta.dirname, "../test/notes-mcp-server.mjs")],
        env: {},
        autoApprove: ["create_card"],
      },
    ]);
    expect(connection.tools.every((tool) => !tool.external)).toBe(true);
  });
});
