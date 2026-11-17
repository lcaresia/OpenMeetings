# 0003: Zoom, Teams and Jitsi through adapters, not a second browser bot

Status: accepted

## Context

The spec asks to leave the capture interface ready for Zoom, Teams and Jitsi, and to evaluate
open source meeting bots (Vexa, Attendee) before writing new ones. Findings (details and
sources in `docs/research/2026-11-16-meet-dom-and-licenses.md`):

- Attendee: Elastic License 2.0. It forbids offering the software as a hosted service, so it
  cannot be bundled into an Apache-2.0 project or its Docker images. Its REST API and webhooks
  (live transcript, chat in and out, join/leave) cover Zoom, Meet, Teams and Webex.
- Vexa: Apache-2.0, compatible. Meet, Teams and Zoom web. Live transcript over WebSocket, but it
  transcribes audio with Whisper (no captions) and needs its own heavy stack; a public endpoint
  for sending chat could not be confirmed.

## Decision

- Google Meet stays a native Playwright adapter (`apps/bot/src/meet`): captions are free and
  we control the DOM handling.
- Every platform is a `CaptureSource`. The bot worker picks a factory by `meeting.platform`,
  so a new platform is one factory plus its selectors.
- Zoom and Teams will be added as an **external backend adapter**: the server talks to an
  Attendee or Vexa instance the user runs themselves, over its public API. Nothing from those
  projects is copied or shipped. Attendee first (complete chat API), Vexa when its chat API
  is confirmed.
- Jitsi is open and simple enough to get a native adapter later.

## Consequences

Meet works out of the box. Zoom and Teams require running a second service, documented as
optional. The license boundary stays clean: integration only over HTTP.
