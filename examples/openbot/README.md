# Example: Open Meetings inside OpenBot

OpenBot runs agents as a persistent team on your machine. It accepts any agent that speaks ACP
and any OpenAI-compatible endpoint. Open Meetings offers both; pick one.

Start the server first (`om serve`, or `docker compose up`).

## As an ACP agent (recommended)

Add a custom ACP agent in OpenBot with:

| Field       | Value                                                     |
| ----------- | --------------------------------------------------------- |
| Command     | `npx`                                                     |
| Arguments   | `-y open-meetings acp --server http://localhost:4319`     |
| Environment | `OM_AUTH_TOKEN=<your token>` (only if the server has one) |

In a session you can then:

- paste a Meet link: the bot joins and decisions and action items arrive as messages;
- ask about the live meeting ("quais os itens de ação?");
- ask about past meetings ("o que ficou pendente da semana passada?");
- ask for the minutes once it ends.

## As an OpenAI-compatible endpoint

Add a provider with:

| Field    | Value                                                                                       |
| -------- | ------------------------------------------------------------------------------------------- |
| Base URL | `http://localhost:4319/v1`                                                                  |
| API key  | your server token, or anything when the server has none                                     |
| Model    | `open-meetings/live` (the meeting happening now) or `open-meetings/history` (past meetings) |

Step by step: [docs/integrations/openbot.md](../../docs/integrations/openbot.md).

OpenBot is distributed under PolyForm Noncommercial 1.0.0. Open Meetings (Apache-2.0) does not
include or derive from any of its code; the two talk only through the public protocols above.
