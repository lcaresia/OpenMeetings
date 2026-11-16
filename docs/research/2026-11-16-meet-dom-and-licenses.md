# Research notes: Meet DOM, reuse options, licenses (2026-11-16)

Collected by reading public repositories and registries. Strings were read through a
summarising fetcher, so each one must be re-checked against a live meeting before it is
trusted. No code was copied. No Portuguese (pt-BR) label was found in any source: every
pt-BR label is unverified, which is why the bot pins the UI language with `?hl=en`.

Sources: Vexa (`Vexa-ai/vexa`, Apache-2.0, `core/meetings/modules/join/src/googlemeet`),
Attendee (`noah-duncan/attendee`, Elastic-2.0, `bots/google_meet_bot_adapter`),
TranscripTonic (`vivek-nexus/transcriptonic`, `extension/content-scripts/google-meet`),
Recall sample (`recallai/google-meet-meeting-bot`, no license: reference only).

## Google Meet DOM

Pre-join

- Name input: `input[type="text"][aria-label="Your name"]`, `...="Enter your name"`;
  locale-agnostic `input[jsname][type="text"]`, `input[type="text"]:not([aria-hidden="true"])`.
- Join button texts: "Ask to join", "Join now", "Ask to join anyway", "Join anyway",
  "Join here too", "Switch here". Last resort `button[jsname]:not([aria-label]):has(span)`.
- Mic/camera: `[aria-label="Turn off microphone"]`, `[aria-label="Turn off camera"]`
  (on state: "Turn on ...").
- Dialogs to dismiss: "Got it", "Continue without microphone and camera",
  `button[aria-label="Close dialog"]`, `[aria-modal="true"] button[aria-label="Close"]`,
  "Continue as guest", `div[role="alertdialog"] button[data-mdc-dialog-action="ok"]`.

State

- Waiting: "Asking to be let in", "You'll join the call when someone lets you in",
  "Waiting for the host to join".
- Admitted: `[data-self-name]` or a real `[data-participant-id]` tile, and no waiting text.
  The Leave button and toolbar also exist in the lobby, so they do not prove admission.
- Denied: "denied your request", "You were denied", "not allowed to join".
- Knock expired: "No one responded to your request to join".
- Not found: "Check your meeting code", "Invalid video call name".
- Removed/ended: "You've been removed from the meeting", "The call ended because everyone
  left", "Your host ended the meeting for everyone", "You left the meeting".
- Blocked: "You can't join this video call" (flaky; projects retry the knock).

Captions

- Button: `button[aria-label="Turn on captions"]` or `"Captions and translation"`; on when
  `aria-pressed="true"` or label "Turn off captions". Locale-agnostic: `.google-symbols`
  element with text `closed_caption_off` / `translate_cc`, then `closest("button")`.
- Shortcut `c` (retried until `aria-pressed="true"`).
- Language: More options -> Settings -> Captions -> `ul[aria-label="Meeting language"]
  li[data-value="<code>"]`.
- Container: `div[role="region"][tabindex="0"]`; English-only alternative
  `[role="region"][aria-label*="Captions"]`.
- Structure: text is rewritten in place (characterData). The text node's parent is the text
  container; its previous sibling holds the speaker name. Speaker blocks are siblings; the
  last children of the list are not transcript blocks. Meet truncates long monologues (text
  shrinks by hundreds of characters) and edits earlier blocks.

Chat

- Open: `button[data-panel-id="2"]` (locale-agnostic), `button[aria-label="Chat with
  everyone"]`, or `.google-symbols` icon text `chat`.
- Input: `textarea[aria-label="Send a message"]`, else the only visible textarea.
- Send: Enter, or the button with icon text `send`.
- Incoming: `[data-message-id]` inside `[role="list"][aria-live="polite"]`; sender from
  `[data-sender-name]` on the message or an ancestor (a run shares one header).
- The DOM only has messages after the panel was opened once.

Participants

- Tiles `[data-participant-id]`, name in `span.notranslate`, self `[data-self-name]`.
  Poll and diff for join/leave. Ignore names matching `/^Google Participant \(|spaces\/|devices\//`.
- No DOM indicator that a participant is external to the organization was found.

Leave: `button[aria-label="Leave call"]`, then `button[aria-label*="Leave"]`.

Anti-automation: Meet may refuse automated browsers at random; signed-in profiles help;
projects run headed Chrome on a virtual display with
`--disable-blink-features=AutomationControlled`; synthetic input is sometimes ignored.

## Reuse for Zoom / Teams / Jitsi

- Vexa: Apache-2.0. Meet, Teams, Zoom web. REST (`X-API-Key`) + WebSocket `/ws`. Audio +
  Whisper, not captions. Public chat endpoint unconfirmed.
- Attendee: Elastic License 2.0 (cannot be embedded or offered as a service). Zoom, Meet,
  Teams, Webex. REST + webhooks (`transcript.update`, `chat_messages.update`,
  `participant_events.join_leave`), `POST /api/v1/bots/{id}/send_chat_message`.

## Packages

- `@ag-ui/core`, `@ag-ui/client`, `@ag-ui/encoder` 1.0.4, MIT. `EventEncoder.encode(event)`
  yields an SSE frame. RunAgentInput: `threadId`, `runId`, `messages`, `tools`, `context`,
  optional `state`, `forwardedProps`, `resume`. Interrupts: `RUN_FINISHED` with
  `outcome: {type: "interrupt", interrupts: [{id, reason, message?, toolCallId?}]}`; resume
  with a new run carrying `resume: [{interruptId, status: "resolved" | "cancelled", payload}]`.
- `@copilotkit/*` 1.88.0, MIT. `CopilotKit/OpenDots`: MIT; documented extension point is
  remote MCP servers over Streamable HTTP.
- OpenBot (`nightly-labs/openbot`): PolyForm Noncommercial 1.0.0. Custom ACP agent is a
  command + args + env; OpenAI-compatible endpoint is an origin + key.
- `@agentclientprotocol/sdk` 2.7.0, Apache-2.0. 2.x removed `AgentSideConnection` /
  `ClientSideConnection`; agent is `acp.agent({name}).onRequest(...).connect(acp.ndJsonStream(...))`.
- Excalidraw: MIT. tldraw: proprietary license (key or watermark): not usable here.
- `sqlite-vec` 0.1.9, MIT OR Apache-2.0. `sqliteVec.load(db)` with better-sqlite3 or with
  `new DatabaseSync(path, {allowExtension: true})` from `node:sqlite`.
