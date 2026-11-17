# 0005: How a meeting maps onto AG-UI runs

Status: accepted

## Context

AG-UI is request/response: the client POSTs a `RunAgentInput`, the server streams events and
ends with `RUN_FINISHED` or `RUN_ERROR`. A meeting is long and mostly driven by people talking,
not by the client. The panel, OpenDots and any CopilotKit frontend must work without a private
protocol. Checked against `@ag-ui/core` 1.0.4 (MIT).

## Decision

`threadId` is the meeting id. Three kinds of run share `POST /agui`:

1. **Subscription** (no new user message): `STATE_SNAPSHOT`, then the transcript so far, then
   everything live until the meeting is closed, then `RUN_FINISHED`. A finished meeting returns
   its snapshot, transcript and minutes and finishes at once.
2. **Command** (last message is a new user message): the request runs in the meeting; the
   stream carries the agent's text (`TEXT_MESSAGE_*`), its tools (`TOOL_CALL_*`,
   `TOOL_CALL_RESULT`) and finishes with the answer.
3. **Resume** (`resume` entries): answers pending confirmations and streams the rest of the
   agent run they belonged to.

Starting a meeting: `forwardedProps.meetingUrl` (and optional `title`) on a subscription run.

Mapping of meeting activity:

| Meeting                                  | AG-UI                                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Notes (`MeetingState`)                   | `STATE_SNAPSHOT` on connect, `STATE_DELTA` (RFC 6902) on change                                        |
| Transcript line, participant, call chat  | `CUSTOM` `om.transcript`, `om.participant`, `om.chat`                                                  |
| Agent run triggered by voice or chat     | `STEP_STARTED`/`STEP_FINISHED` `agent:<id>` inside the subscription; the full answer as a text message |
| Confirmation of an external action       | command run: `RUN_FINISHED` with `outcome: {type: "interrupt"}`; subscription: `CUSTOM om.approval`    |
| Cost, latency, minutes, status, warnings | `CUSTOM` `om.cost`, `om.latency`, `om.minutes`, `om.status`, `om.warning`                              |

`RUN_STARTED`/`RUN_FINISHED` therefore bracket a subscription (the meeting, for that client) or
one command, as the spec asks; agent runs inside a subscription are steps, because AG-UI has no
nested runs in one stream.

## Consequences

Any AG-UI client renders the notes with no custom code (shared state), and approvals use the
standard interrupt flow. Transcript lines need a small custom-event handler, which is the
documented way to carry domain events.
