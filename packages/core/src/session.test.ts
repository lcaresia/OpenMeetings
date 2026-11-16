import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { matchWakeWord, parseChatCommand, quickIntent } from "./commands";
import { type Fixture, loadFixture } from "./fixture";
import { replayFixture } from "./replay";
import type { AgentRunner, SessionOptions } from "./session";
import { createRuleLlm } from "./testing";

const fixturesDir = join(import.meta.dirname, "../../../fixtures");
const weekly = loadFixture("weekly-sync", fixturesDir);
const expected = JSON.parse(
  readFileSync(join(fixturesDir, "weekly-sync/expected.json"), "utf8"),
) as {
  commands: { said: string; replyIncludes: string[] }[];
};
const WAKE = ["open meetings", "ei open", "hey open"];

type FixtureEvent = Fixture["events"][number];

function meeting(events: FixtureEvent[], participants = weekly.participants): Fixture {
  return { meeting: { id: "t", language: "pt-BR" }, participants, events };
}

async function run(
  fixture: Fixture,
  options: Partial<SessionOptions> & { agent?: AgentRunner } = {},
) {
  const llm = createRuleLlm();
  const result = await replayFixture(fixture, { fast: llm, smart: llm }, options);
  const replies = result.events.flatMap((event) => (event.type === "reply" ? [event.text] : []));
  return { ...result, llm, replies };
}

const say = (t: number, speaker: string, text: string): FixtureEvent => ({
  t,
  type: "caption",
  speaker,
  text,
});
const chat = (t: number, sender: string, text: string): FixtureEvent => ({
  t,
  type: "chat",
  sender,
  text,
});
const join_ = (t: number, participant: string): FixtureEvent => ({ t, type: "join", participant });

describe("wake word", () => {
  it.each([
    ["Open Meetings, quais são os itens de ação?", "quais são os itens de ação?"],
    ["então open meeting faz um resumo", "faz um resumo"],
    ["Ei, Open! Crie um cronograma.", "Crie um cronograma."],
    ["Opem Meetings o que decidimos", "o que decidimos"],
  ])("hears %j", (text, rest) => expect(matchWakeWord(text, WAKE)?.rest).toBe(rest));

  it.each([
    "Vamos abrir a reunião agora",
    "the open source meeting notes",
    "hoje o pen drive sumiu",
  ])("ignores %j", (text) => expect(matchWakeWord(text, WAKE)).toBeUndefined());

  it("parses chat commands, with literal control words", () => {
    expect(parseChatCommand("om sair", WAKE)).toEqual({ request: "sair", exact: "leave" });
    expect(parseChatCommand("OM: Pausar", WAKE)).toEqual({ request: "Pausar", exact: "pause" });
    expect(parseChatCommand("om crie uma planilha de custos", WAKE)).toEqual({
      request: "crie uma planilha de custos",
    });
    expect(parseChatCommand("como vai?", WAKE)).toBeUndefined();
    expect(parseChatCommand("omelete no almoço", WAKE)).toBeUndefined();
  });

  it("does not shortcut a compound request to a built-in command", () => {
    expect(quickIntent("faça um resumo")).toBe("summary");
    expect(quickIntent("faça um resumo e envie por e-mail")).toBeUndefined();
  });
});

describe("session: weekly-sync", () => {
  it("announces itself on joining and to people who arrive later", async () => {
    const { replies, source, session } = await run(weekly);
    expect(replies[0]).toBe(session.options.joinMessage);
    expect(replies.filter((text) => text === session.options.joinMessage)).toHaveLength(3);
    expect(source.sentChat[0]).toContain("assistente de IA");
  });

  it("answers a spoken command in the call chat, from the notes", async () => {
    const { replies, events } = await run(weekly);
    for (const want of expected.commands) {
      const command = events.find((event) => event.type === "command");
      expect(command).toMatchObject({
        command: { intent: "action_items", via: "voice", from: "Ana Souza" },
      });
      const reply = replies.find((text) => want.replyIncludes.every((part) => text.includes(part)));
      expect(reply, want.said).toBeDefined();
      expect(reply).toContain("responsável: Bruno");
    }
  });
});

describe("session: commands", () => {
  it("takes the next sentence as the request when the name is said alone", async () => {
    const { replies } = await run(
      meeting([
        join_(0, "ana"),
        say(1000, "ana", "Então fica decidido que vamos usar Postgres."),
        say(9000, "ana", "Open Meetings."),
        say(12000, "ana", "O que decidimos até agora?"),
      ]),
    );
    expect(replies.at(-1)).toContain("vamos usar Postgres");
  });

  it("stops recording the moment someone types om pausar, and resumes on om continuar", async () => {
    const { pipeline, events } = await run(
      meeting([
        join_(0, "ana"),
        say(1000, "ana", "Isso pode ser anotado."),
        chat(5000, "bruno", "om pausar"),
        say(6000, "ana", "Isso é confidencial, salário do time."),
        chat(9000, "bruno", "om continuar"),
        say(10000, "ana", "Voltando ao assunto."),
      ]),
    );
    const texts = pipeline.segments.map((segment) => segment.text).join(" ");
    expect(texts).toContain("pode ser anotado");
    expect(texts).toContain("Voltando ao assunto");
    expect(texts).not.toContain("confidencial");
    expect(JSON.stringify(events)).not.toContain("confidencial");
  });

  it("leaves on om sair from any participant, without needing a model", async () => {
    const { pipeline, events, replies, llm } = await run(
      meeting([
        join_(0, "ana"),
        chat(2000, "carla", "om sair"),
        say(3000, "ana", "Depois que o bot saiu."),
      ]),
    );
    expect(pipeline.segments).toEqual([]);
    expect(replies.at(-1)).toMatch(/Saindo/);
    expect(events.filter((event) => event.type === "status").at(-1)).toMatchObject({
      status: "left",
    });
    expect(llm.calls).toEqual([]);
  });

  it("hands anything else to the agent and posts its answer", async () => {
    const seen: string[] = [];
    const agent: AgentRunner = {
      async run(command) {
        seen.push(command.request);
        return "Cronograma criado.";
      },
    };
    const { replies } = await run(
      meeting([join_(0, "ana"), chat(1000, "ana", "om crie um cronograma do projeto")]),
      { agent },
    );
    expect(seen).toEqual(["crie um cronograma do projeto"]);
    expect(replies.at(-1)).toBe("Cronograma criado.");
  });

  it("ignores its own chat messages", async () => {
    const people = [...weekly.participants, { id: "bot", name: "Open Meetings (assistente IA)" }];
    const { events } = await run(meeting([join_(0, "ana"), chat(1000, "bot", "om sair")], people));
    expect(events.some((event) => event.type === "command")).toBe(false);
  });
});

describe("session: external guests", () => {
  const people = [
    { id: "ana", name: "Ana Souza", external: false },
    { id: "guest", name: "Cliente Externo", external: true },
  ];
  const script = [
    join_(0, "ana"),
    say(1000, "ana", "Reunião interna por enquanto."),
    join_(5000, "guest"),
    say(6000, "ana", "Agora com o cliente na sala."),
  ];

  it("allow: keeps going and announces again", async () => {
    const { pipeline, replies, session } = await run(meeting(script, people), {
      externalGuests: "allow",
    });
    expect(pipeline.segments).toHaveLength(2);
    expect(replies.filter((text) => text === session.options.joinMessage)).toHaveLength(2);
  });

  it("leave: goes away when an external guest joins", async () => {
    const { pipeline, replies, session } = await run(meeting(script, people), {
      externalGuests: "leave",
    });
    expect(replies.at(-1)).toMatch(/vou sair/);
    expect(session.status).toBe("left");
    expect(pipeline.segments.map((s) => s.text).join()).not.toContain("cliente na sala");
  });

  it("ask: pauses until an internal participant confirms", async () => {
    const { pipeline, replies } = await run(
      meeting(
        [
          ...script,
          chat(7000, "guest", "om continuar"),
          say(8000, "ana", "Ainda pausado."),
          chat(9000, "ana", "om continuar"),
          say(10000, "ana", "Liberado pela equipe."),
        ],
        people,
      ),
      { externalGuests: "ask" },
    );
    const texts = pipeline.segments.map((segment) => segment.text).join(" ");
    expect(texts).not.toContain("cliente na sala");
    expect(texts).not.toContain("Ainda pausado");
    expect(texts).toContain("Liberado pela equipe");
    expect(replies.some((text) => text.includes("Só alguém da organização"))).toBe(true);
  });

  it("treats unknown people as external once internal domains are configured", async () => {
    const unknown = [
      { id: "ana", name: "Ana Souza" },
      { id: "guest", name: "Sem Email" },
    ];
    const { session } = await run(meeting([join_(0, "ana")], unknown), {
      externalGuests: "leave",
      internalDomains: ["loopert.com.br"],
    });
    expect(session.status).toBe("left");
  });
});
