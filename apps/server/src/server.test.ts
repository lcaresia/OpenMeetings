import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch, emptyState, type MeetingState } from "@open-meetings/core";
import { createLiveSource, createScriptedLlm } from "@open-meetings/core/testing";
import { defineTool } from "@open-meetings/tools";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { App } from "./app";
import { markdownToDocx, tableToXlsx } from "./export/formats";
import { aguiRun, collect, startTestApp } from "./testing";

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** A meeting the test drives line by line. */
function liveMeeting(target: App, title = "Sync semanal") {
  const source = createLiveSource();
  const live = target.manager.start({ source, title });
  return { source, live, id: live.record.id };
}

function weeklyScript(source: ReturnType<typeof createLiveSource>) {
  source.join("ana", "Ana Souza");
  source.join("bruno", "Bruno Lima");
  source.say("Ana Souza", "Então fica decidido que o lançamento será no dia 15 de dezembro.");
  source.say(
    "Ana Souza",
    "Bruno, você fica responsável por atualizar o contrato com o gateway até sexta-feira.",
  );
  source.say("Bruno Lima", "Alguém sabe se o jurídico já aprovou os termos de uso?");
}

describe("AG-UI subscription", () => {
  it("streams a snapshot, then deltas a client can replay to the exact server state", async () => {
    app = await startTestApp();
    const { source, id, live } = liveMeeting(app);
    const stream = aguiRun(app.url, { threadId: id });

    const first = await stream.next();
    expect(first.value).toMatchObject({ type: "RUN_STARTED", threadId: id });
    const snapshot = await stream.next();
    expect(snapshot.value).toMatchObject({ type: "STATE_SNAPSHOT" });

    weeklyScript(source);
    source.chat("Ana Souza", "om o que decidimos?");
    source.end();
    const events = await collect(stream);

    let client = (snapshot.value as { snapshot: MeetingState }).snapshot ?? emptyState();
    for (const event of events)
      if (event.type === "STATE_DELTA") client = applyPatch(client, event.delta as never);
    await live.done;
    const saved = app.manager.get(id);
    expect(client).toEqual(saved?.state);
    expect(saved?.state.decisions[0]?.text).toContain("15 de dezembro");

    const customs = (name: string) =>
      events.filter((event) => event.type === "CUSTOM" && event.name === name);
    expect(customs("om.transcript")).toHaveLength(3);
    expect(customs("om.participant")).toHaveLength(2);
    expect(customs("om.minutes")).toHaveLength(1);
    expect(customs("om.latency").length).toBeGreaterThan(0);
    const reply = events.find(
      (event) => event.type === "TEXT_MESSAGE_CONTENT" && String(event.delta).includes("Decisões"),
    );
    expect(reply).toBeDefined();
    expect(events.at(-1)).toMatchObject({ type: "RUN_FINISHED", threadId: id });
  });

  it("serves a finished meeting as a snapshot with its transcript and minutes", async () => {
    app = await startTestApp();
    const { source, id, live } = liveMeeting(app);
    weeklyScript(source);
    source.end();
    await live.done;

    const events = await collect(aguiRun(app.url, { threadId: id }));
    expect(events.map((event) => event.type)).toEqual([
      "RUN_STARTED",
      "STATE_SNAPSHOT",
      "CUSTOM", // om.meeting
      "CUSTOM",
      "CUSTOM",
      "CUSTOM", // three transcript lines
      "CUSTOM", // om.minutes
      "RUN_FINISHED",
    ]);
    const minutes = events.find((event) => event.name === "om.minutes")?.value as {
      markdown: string;
    };
    expect(minutes.markdown).toContain("## Itens de ação");
    expect(minutes.markdown).toContain(
      "atualizar o contrato com o gateway (responsável: Bruno, prazo: sexta-feira)",
    );
  });

  it("reports an unknown meeting as RUN_ERROR", async () => {
    app = await startTestApp();
    const events = await collect(aguiRun(app.url, { threadId: "nope" }));
    expect(events).toEqual([expect.objectContaining({ type: "RUN_ERROR", code: "not_found" })]);
  });
});

describe("AG-UI commands and approvals", () => {
  it("answers a command as a text message in its own run", async () => {
    app = await startTestApp();
    const { source, id } = liveMeeting(app);
    weeklyScript(source);
    const events = await collect(
      aguiRun(app.url, {
        threadId: id,
        messages: [{ id: "u1", role: "user", content: "quais são os itens de ação?" }],
      }),
    );
    const text = events
      .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
      .map((e) => e.delta)
      .join("");
    expect(text).toContain("atualizar o contrato");
    expect(events.map((e) => e.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    source.end();
  });

  it("interrupts for an action outside the meeting and continues on resume", async () => {
    const created: string[] = [];
    const tool = defineTool({
      name: "linear_create_issue",
      description: "Create an issue",
      schema: z.object({ title: z.string() }),
      external: true,
      summarize: (args) => `abrir a issue "${args.title}"`,
      run: async (args) => {
        created.push(args.title);
        return { content: `issue ${args.title} created` };
      },
    });
    const smart = createScriptedLlm([
      {
        text: "Vou abrir a issue. ",
        toolCalls: [{ name: "linear_create_issue", arguments: { title: "Bug no login" } }],
      },
      "Issue aberta.",
    ]);
    app = await startTestApp({ smart, tools: [tool] });
    const { source, id } = liveMeeting(app);

    const first = await collect(
      aguiRun(app.url, {
        threadId: id,
        messages: [{ id: "u1", role: "user", content: "abre uma issue do bug no login" }],
      }),
    );
    const finished = first.at(-1) as {
      type: string;
      outcome?: { type: string; interrupts: { id: string; message: string }[] };
    };
    expect(finished.type).toBe("RUN_FINISHED");
    expect(finished.outcome?.type).toBe("interrupt");
    expect(finished.outcome?.interrupts[0]?.message).toBe('abrir a issue "Bug no login"');
    expect(
      first.some((e) => e.type === "TOOL_CALL_START" && e.toolCallName === "linear_create_issue"),
    ).toBe(true);
    expect(created).toEqual([]);

    const interruptId = finished.outcome?.interrupts[0]?.id ?? "";
    const second = await collect(
      aguiRun(app.url, {
        threadId: id,
        resume: [{ interruptId, status: "resolved", payload: { approved: true } }],
      }),
    );
    expect(created).toEqual(["Bug no login"]);
    expect(second.find((e) => e.type === "TOOL_CALL_RESULT")).toMatchObject({
      content: "issue Bug no login created",
    });
    expect(
      second
        .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
        .map((e) => e.delta)
        .join(""),
    ).toContain("Issue aberta.");
    expect(second.at(-1)?.type).toBe("RUN_FINISHED");
    source.end();
  });
});

describe("HTTP API", () => {
  it("requires the token on the API, not on the panel files", async () => {
    app = await startTestApp({
      yaml: `
engines:
  llm:
    fast: { provider: openai-compatible, baseUrl: "http://localhost:1/v1", model: rule }
    smart: { provider: openai-compatible, baseUrl: "http://localhost:1/v1", model: rule }
storage: { driver: sqlite, path: ":memory:" }
server: { authToken: s3cret-token-value }
`,
    });
    expect((await fetch(`${app.url}/api/meetings`)).status).toBe(401);
    expect(
      (await fetch(`${app.url}/api/meetings`, { headers: { authorization: "Bearer wrong" } }))
        .status,
    ).toBe(401);
    expect((await fetch(`${app.url}/agui`, { method: "POST", body: "{}" })).status).toBe(401);
    const ok = await fetch(`${app.url}/api/meetings`, {
      headers: { authorization: "Bearer s3cret-token-value" },
    });
    expect(ok.status).toBe(200);
    const config = (await (
      await fetch(`${app.url}/api/config`, {
        headers: { authorization: "Bearer s3cret-token-value" },
      })
    ).json()) as { server: { authToken: string } };
    expect(config.server.authToken).toBe("[redacted]");
  });

  it("lists, shows and deletes meetings", async () => {
    app = await startTestApp();
    const { source, id, live } = liveMeeting(app, "Planejamento Q1");
    weeklyScript(source);
    source.end();
    await live.done;

    const list = (await (await fetch(`${app.url}/api/meetings`)).json()) as {
      id: string;
      status: string;
      minutes?: string;
    }[];
    expect(list).toMatchObject([{ id, status: "ended" }]);
    const detail = (await (await fetch(`${app.url}/api/meetings/${id}`)).json()) as {
      segments: unknown[];
      live: boolean;
    };
    expect(detail).toMatchObject({ live: false });
    expect(detail.segments).toHaveLength(3);
    expect(
      (await fetch(`${app.url}/api/meetings/${id}/minutes`)).headers.get("content-type"),
    ).toContain("markdown");

    expect((await fetch(`${app.url}/api/meetings/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${app.url}/api/meetings/${id}`)).status).toBe(404);
    expect(app.store.listSegments(id)).toEqual([]);
  });

  it("validates input", async () => {
    app = await startTestApp();
    const post = (path: string, body: string) =>
      fetch(`${app?.url}${path}`, { method: "POST", body });
    expect((await post("/api/meetings", "{}")).status).toBe(400);
    expect((await post("/api/meetings", "not json")).status).toBe(400);
    expect((await post("/api/meetings/x/commands", '{"text":"oi"}')).status).toBe(409);
    expect((await fetch(`${app.url}/api/search`)).status).toBe(400);
  });
});

describe("after the meeting", () => {
  it("posts the minutes in the chat, indexes the meeting and calls the webhook", async () => {
    const hooks: unknown[] = [];
    app = await startTestApp({
      yaml: `
engines:
  llm:
    fast: { provider: openai-compatible, baseUrl: "http://localhost:1/v1", model: rule }
    smart: { provider: openai-compatible, baseUrl: "http://localhost:1/v1", model: rule }
storage: { driver: sqlite, path: ":memory:" }
outputs: { postSummaryTo: [chat, webhook], webhookUrl: "https://hooks.example.com/om" }
`,
      fetch: async (input, init) => {
        hooks.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return new Response("ok");
      },
    });
    const { source, id, live } = liveMeeting(app);
    weeklyScript(source);
    source.end();
    await live.done;

    expect(source.sent.at(-1)).toContain("Ata da reunião:");
    expect(source.sent.at(-1)).toContain("atualizar o contrato com o gateway");
    expect(hooks).toMatchObject([
      {
        url: "https://hooks.example.com/om",
        body: {
          event: "meeting.ended",
          meeting: { id },
          minutes: expect.stringContaining("# Ata"),
        },
      },
    ]);

    const hits = (await (
      await fetch(`${app.url}/api/search?q=${encodeURIComponent("contrato do gateway")}`)
    ).json()) as {
      meetingId: string;
      text: string;
    }[];
    expect(hits[0]?.meetingId).toBe(id);
    expect(hits[0]?.text).toContain("contrato");
  });

  it("remembers what was left pending in the previous meeting of the series", async () => {
    const seen: string[] = [];
    const smart = createScriptedLlm([
      (req) => {
        if (req.purpose === "agent") seen.push(req.messages[1]?.content ?? "");
        return "Ficou pendente: atualizar o contrato (Bruno).";
      },
    ]);
    app = await startTestApp({ smart });
    const first = liveMeeting(app, "Sync semanal");
    weeklyScript(first.source);
    first.source.end();
    await first.live.done;

    const second = liveMeeting(app, "Sync Semanal");
    second.source.chat("Ana Souza", "om o que ficou pendente da semana passada?");
    await second.source.waitForChat("Ficou pendente");
    second.source.end();
    await second.live.done;

    expect(seen[0]).toContain("PREVIOUS MEETING OF THIS SERIES");
    expect(seen[0]).toContain("atualizar o contrato com o gateway");
  });

  it("deletes meetings past the retention period", async () => {
    app = await startTestApp();
    const { source, id, live } = liveMeeting(app);
    source.end();
    await live.done;
    app.store.updateMeeting(id, { startedAt: "2020-01-01T00:00:00.000Z" });
    expect(app.manager.purgeExpired()).toBe(1);
    expect(app.store.getMeeting(id)).toBeUndefined();
  });
});

describe("exports", () => {
  const python = ["/usr/bin/python3", "/usr/local/bin/python3"].find((path) => existsSync(path));

  it.skipIf(!python)("writes .docx and .xlsx files that are valid zips of well-formed XML", () => {
    const dir = mkdtempSync(join(tmpdir(), "om-export-"));
    const docx = join(dir, "a.docx");
    const xlsx = join(dir, "a.xlsx");
    writeFileSync(
      docx,
      markdownToDocx(
        "# Ata\n\n## Decisões\n\n- Lançar **dia 15** <ok> & cia\n1. Um\n2. Dois\n\nTexto [link](https://x.y)",
      ),
    );
    writeFileSync(
      xlsx,
      tableToXlsx(
        [
          ["item", "valor", "ok"],
          ["API", 10.5, true],
          ["Café & pão", null, false],
        ],
        "Custos/2026",
      ),
    );
    const check = String.raw`
import sys, zipfile, xml.dom.minidom
for path in sys.argv[1:]:
    with zipfile.ZipFile(path) as z:
        assert z.testzip() is None
        for name in z.namelist():
            xml.dom.minidom.parseString(z.read(name))
        print(path.split("/")[-1], sorted(z.namelist()))
        if path.endswith(".docx"):
            body = z.read("word/document.xml").decode()
            assert "Lançar " in body and "&lt;ok&gt; &amp; cia" in body and "link (https://x.y)" in body, body
        else:
            sheet = z.read("xl/worksheets/sheet1.xml").decode()
            assert '<c r="B2"><v>10.5</v></c>' in sheet and 't="b"' in sheet and "Café &amp; pão" in sheet, sheet
`;
    const out = execFileSync(python ?? "python3", ["-I", "-c", check, docx, xlsx], {
      encoding: "utf8",
    });
    expect(out).toContain("word/document.xml");
    expect(out).toContain("xl/worksheets/sheet1.xml");
  });
});
