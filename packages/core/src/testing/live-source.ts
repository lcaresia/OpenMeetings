import { AsyncQueue } from "../async-queue";
import type { CaptureEvent, CaptureSource } from "../types";

/** A capture source a test pushes events into while the session runs. */
export function createLiveSource() {
  const queue = new AsyncQueue<CaptureEvent>();
  const sent: string[] = [];
  const waiters: { match: (text: string) => boolean; resolve: (text: string) => void }[] = [];
  let clock = 0;

  const source: CaptureSource & {
    sent: string[];
    push(event: CaptureEvent): void;
    say(speaker: string, text: string): void;
    chat(sender: string, text: string): void;
    join(id: string, name: string, external?: boolean): void;
    /** Resolves with the first chat message the session posts that matches. */
    waitForChat(match: string | RegExp): Promise<string>;
    end(): void;
  } = {
    id: "live",
    sent,
    async *start() {
      yield* queue;
    },
    async sendChat(text) {
      sent.push(text);
      for (const waiter of [...waiters]) {
        if (!waiter.match(text)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(text);
      }
    },
    async stop() {
      queue.close();
    },
    push: (event) => queue.push(event),
    say(speaker, text) {
      // Gaps longer than the pipeline's merge window, so every call stays its own segment.
      clock += 5000;
      queue.push({
        type: "transcript",
        segment: {
          id: `s${clock}`,
          speaker,
          text,
          startMs: clock - 2500,
          endMs: clock,
          source: "fixture",
        },
      });
    },
    chat(sender, text) {
      clock += 1000;
      queue.push({ type: "chat", message: { id: `c${clock}`, sender, text, atMs: clock } });
    },
    join(id, name, external) {
      queue.push({
        type: "participant",
        action: "joined",
        participant: { id, name, ...(external === undefined ? {} : { external }) },
        atMs: clock,
      });
    },
    waitForChat(match) {
      const test = (text: string) =>
        typeof match === "string" ? text.includes(match) : match.test(text);
      const found = sent.find(test);
      if (found) return Promise.resolve(found);
      return new Promise((resolve) => waiters.push({ match: test, resolve }));
    },
    end() {
      queue.push({ type: "ended", reason: "test finished" });
      queue.close();
    },
  };
  return source;
}
