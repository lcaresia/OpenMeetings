# Writing a platform adapter

A platform (Meet, Zoom, Teams, Jitsi) is a `CaptureSource` (`packages/core/src/types.ts`):

```ts
interface CaptureSource {
  id: string;
  start(meeting: MeetingRef): AsyncIterable<CaptureEvent>; // transcript | audio | participant | chat | ended
  sendChat?(text: string): Promise<void>;
  speak?(audio: ReadableStream): Promise<void>;
  stop(): Promise<void>;
}
```

The session, pipeline and agent do not know which platform they are on.

## Browser-driven platforms (like Meet)

Follow `apps/bot/src/meet`:

| File             | Role                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `selectors.ts`   | Every selector, in fallback order. The only file to touch when the platform changes its UI                 |
| `page-script.ts` | Code injected in the page: reports raw DOM facts (captions, chat, tiles) through `__omEmit`                |
| `meet-source.ts` | Joins, waits for admission, turns captions on, maps page messages to capture events, posts in chat, leaves |

Then register the factory in `apps/bot/src/main.ts` under the platform id, and add the host to
`platformOf` in `apps/server/src/manager.ts`.

Rules that keep it maintainable:

- Keep logic out of the page. Deduplicate and time things in Node (`CaptionStabilizer`), where
  they are unit tested.
- Prefer aria-labels and text over class names, which are obfuscated and change weekly.
- Detect "admitted" positively (something only present inside the call), not by the toolbar.
- Report join failures as typed errors (denied, not found, blocked, timeout).
- Test against a fake page built from documented DOM facts (`apps/bot/test/fake-meet.html`),
  and add a live smoke check that never joins (`apps/bot/src/smoke.ts`).

## API-driven platforms

For Zoom and Teams the plan is an adapter over an external meeting-bot service the user runs
(Attendee, Vexa), talking to its public API (ADR 0003): turn its live-transcript webhooks or
stream into `transcript` events and its chat endpoint into `sendChat`. Nothing from those
projects is bundled.

## Other sources

`apps/server/src/file-source.ts` (uploads) and `apps/server/src/capture-hub.ts` (the browser
extension) are small sources worth reading before writing one.
