# 0006: Open Meetings and OpenDots / OpenBot: protocols only

Status: accepted

## Context

OpenDots (CopilotKit) builds AI coworkers that also handle calls; OpenBot runs agents as a team on
the desktop. The spec wants Open Meetings to work alone and as a piece of both, and to respect
their licenses. Findings (sources in `docs/research/2026-11-16-meet-dom-and-licenses.md`):

- `CopilotKit/OpenDots` is MIT. Its documented extension point for Dots is remote MCP servers
  over Streamable HTTP; no documented way to attach an external AG-UI agent was found.
- `@ag-ui/*` 1.0.4 and `@copilotkit/*` 1.88.0 are MIT.
- OpenBot is PolyForm Noncommercial 1.0.0: source-available, not open source.
- `@agentclientprotocol/sdk` 2.7.0 is Apache-2.0.

## Decision

- **Boundary.** Open Meetings is the meeting specialist: platform capture (the Meet bot, the
  browser extension, files), the structured meeting state, minutes, memory across meetings.
  OpenDots (or OpenBot) orchestrates and talks to people. OpenDots' own call layer is left alone;
  Open Meetings does not try to be a general assistant.
- **Integration is by protocol only**: AG-UI (`/agui`), MCP (`/mcp`), ACP (`om acp` as agent,
  `tools.acp_agents` as client) and an OpenAI-compatible endpoint (`/v1`). No code from OpenBot
  or OpenDots is copied, vendored or derived. Their names appear only as "compatible with".
- **Dependencies**: `@ag-ui/core`, `@ag-ui/encoder` (server), `@ag-ui/client` (tests only),
  `@agentclientprotocol/sdk`, `@modelcontextprotocol/sdk`. All MIT or Apache-2.0, listed in
  `THIRD_PARTY_NOTICES.md`. CopilotKit's React components are not used: the panel is a small
  AG-UI client of its own, which kept the bundle small.

## Consequences

Any AG-UI frontend, MCP host or ACP client works with Open Meetings without code on their side.
The OpenDots and OpenBot integrations are verified against the official protocol SDKs in CI,
not against running installations of those apps.
