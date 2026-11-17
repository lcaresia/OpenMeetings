import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { CaptureEvent, CaptureSource, MeetingRef, Participant } from "./types";

const at = z.number().min(0);

export const fixtureSchema = z.object({
  meeting: z.object({
    id: z.string(),
    title: z.string().optional(),
    language: z.string().default("pt-BR"),
    /** ISO date the meeting "happened" on, so relative dates resolve the same way on every run. */
    date: z.string().optional(),
  }),
  participants: z.array(
    z.object({ id: z.string(), name: z.string(), external: z.boolean().optional() }),
  ),
  events: z.array(
    z.discriminatedUnion("type", [
      z.object({ t: at, type: z.literal("join"), participant: z.string() }),
      z.object({ t: at, type: z.literal("leave"), participant: z.string() }),
      z.object({
        t: at,
        type: z.literal("caption"),
        speaker: z.string(),
        text: z.string(),
        durationMs: z.number().optional(),
      }),
      z.object({ t: at, type: z.literal("chat"), sender: z.string(), text: z.string() }),
    ]),
  ),
});

export type Fixture = z.infer<typeof fixtureSchema>;

/** Accepts a fixture name (`weekly-sync`), a directory, or a path to `captions.json`. */
export function loadFixture(nameOrPath: string, ...fixturesDirs: string[]): Fixture {
  const dirs = fixturesDirs.length ? fixturesDirs : ["fixtures"];
  const candidates = [
    nameOrPath,
    join(nameOrPath, "captions.json"),
    ...dirs.map((dir) => join(dir, nameOrPath, "captions.json")),
  ].map((path) => resolve(path));
  const file = candidates.find((path) => existsSync(path) && path.endsWith(".json"));
  if (!file) throw new Error(`Fixture not found: ${nameOrPath}`);
  return fixtureSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

/**
 * Replays a recorded meeting as if it were live. `speed` divides the waits between events;
 * the default (Infinity) replays with no waiting at all.
 */
export class FixtureSource implements CaptureSource {
  readonly id = "fixture";
  /** Everything the agent wrote to the call's chat. */
  readonly sentChat: string[] = [];
  private stopped = false;

  constructor(
    private readonly fixture: Fixture,
    private readonly options: { speed?: number } = {},
  ) {}

  meetingRef(): MeetingRef {
    const { id, title } = this.fixture.meeting;
    return { id, platform: "fixture", ...(title ? { title } : {}) };
  }

  async *start(_meeting?: MeetingRef): AsyncGenerator<CaptureEvent> {
    const speed = this.options.speed ?? Number.POSITIVE_INFINITY;
    const people = new Map<string, Participant>(this.fixture.participants.map((p) => [p.id, p]));
    const person = (id: string): Participant => people.get(id) ?? { id, name: id };
    let previous = 0;
    let counter = 0;

    for (const event of this.fixture.events) {
      if (this.stopped) return;
      const wait = (event.t - previous) / speed;
      if (wait >= 1) await sleep(wait);
      previous = event.t;

      if (event.type === "join" || event.type === "leave") {
        yield {
          type: "participant",
          action: event.type === "join" ? "joined" : "left",
          participant: person(event.participant),
          atMs: event.t,
        };
      } else if (event.type === "caption") {
        counter++;
        yield {
          type: "transcript",
          segment: {
            id: `s${counter}`,
            speaker: person(event.speaker).name,
            text: event.text,
            startMs: event.t,
            endMs: event.t + (event.durationMs ?? Math.max(1000, event.text.length * 60)),
            source: "fixture",
            language: this.fixture.meeting.language,
          },
        };
      } else {
        counter++;
        yield {
          type: "chat",
          message: {
            id: `c${counter}`,
            sender: person(event.sender).name,
            text: event.text,
            atMs: event.t,
          },
        };
      }
    }
    yield { type: "ended", reason: "fixture finished" };
  }

  async sendChat(text: string): Promise<void> {
    this.sentChat.push(text);
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}
