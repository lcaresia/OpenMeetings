# Example: a "Meeting Dot" for OpenDots

OpenDots (CopilotKit, MIT) builds AI coworkers called Dots. Its documented way to give a Dot new
abilities is a remote MCP server over Streamable HTTP. Open Meetings serves one at `/mcp`, so a
Dot can send the bot to a call, follow it and report the outcome with no custom code inside
OpenDots.

This folder has:

| File             | What it is                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `meeting-dot.md` | Role and instructions for the Dot                                                           |
| `relay.mjs`      | Optional: streams one meeting over AG-UI to a Slack channel as it happens (no dependencies) |

Step by step: [docs/integrations/opendots.md](../../docs/integrations/opendots.md).

Open Meetings is compatible with OpenDots; it is not part of it and shares no code with it.
