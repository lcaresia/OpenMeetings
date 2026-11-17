# Configuration

Everything is in one YAML file, `openmeetings.config.yaml` (or the path in `OM_CONFIG`),
validated at startup. `om init` writes one for you; `examples/` has the four profiles.
`om doctor` validates the file, tests every engine and estimates the cost per meeting hour.

`${VAR}` and `${VAR:-default}` are replaced with environment variables. Quote them
(`apiKey: "${GROQ_API_KEY}"`): unquoted braces are not valid YAML in flow maps (ADR 0001).

## Sections

### `profile`

A label. `local` additionally blocks every request to a non-private address, enforced in one
place for all engines and the webhook (see `network.localOnly`).

### `engines`

| Key         | Providers                        | Notes                                                                                                 |
| ----------- | -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `llm.fast`  | `openai-compatible`, `anthropic` | Runs continuously: notes, intent detection. Small and cheap                                           |
| `llm.smart` | `openai-compatible`, `anthropic` | Commands, artifacts, minutes summary                                                                  |
| `stt`       | `none`, `openai-compatible`      | `/v1/audio/transcriptions`: whisper.cpp server, Speaches, Groq, OpenAI. Not needed with Meet captions |
| `tts`       | `none`, `openai-compatible`      | `/v1/audio/speech` (Kokoro, Piper, OpenAI). Reserved for voice replies                                |
| `embed`     | `none`, `openai-compatible`      | `/v1/embeddings` (Ollama `nomic-embed-text`, OpenAI). Enables semantic search                         |

`openai-compatible` covers Ollama, llama.cpp, vLLM, LM Studio, Groq, OpenRouter, DeepSeek,
Together, OpenAI and Gemini (`https://generativelanguage.googleapis.com/v1beta/openai`).

```yaml
engines:
  llm:
    fast:
      provider: openai-compatible
      baseUrl: http://localhost:11434/v1
      model: qwen2.5:7b
      toolCalling: native # json for models without tool calling (validated JSON fallback)
      maxTokens: 2000 # optional
    smart:
      provider: anthropic
      model: claude-sonnet-5-5
      apiKey: "${ANTHROPIC_API_KEY}"
      maxTokens: 16000
```

### `pricing`

USD per 1M tokens by model id, for the cost meter (`{ in, out }`). Models served from a private
address cost nothing; a remote model without a price shows as unknown, never as free.

### `agent`

| Key                  | Default                                |                                              |
| -------------------- | -------------------------------------- | -------------------------------------------- |
| `name`               | `Open Meetings`                        | How the agent calls itself                   |
| `wakeWords`          | `open meetings`, `ei open`, `hey open` | Matched fuzzily on every line, at no cost    |
| `language`           | `pt-BR`                                | Language of notes, answers and minutes       |
| `proactive`          | `false`                                | Reserved for suggestions without being asked |
| `summaryIntervalSec` | `45`                                   | How often the fast model updates the notes   |
| `maxToolSteps`       | `8`                                    | Upper bound on model turns per request       |

### `consent`

| Key               | Default      |                                                                                            |
| ----------------- | ------------ | ------------------------------------------------------------------------------------------ |
| `announceOnJoin`  | `true`       | Cannot be disabled: the bot always identifies itself                                       |
| `joinMessage`     | (pt-BR text) | Posted on joining and to late arrivals                                                     |
| `externalGuests`  | `allow`      | `allow` (re-announce), `ask` (pause until someone internal types `om continuar`), `leave`  |
| `internalDomains` | `[]`         | Email domains of the organization. With a list, anyone not placed in it counts as external |
| `retentionDays`   | `90`         | Meetings older than this are deleted. `0` keeps everything                                 |

### `storage`

`driver: sqlite` with `path`. Postgres is not available yet (ADR 0004).

### `server`

`host` (default `127.0.0.1`), `port` (`4319`), `authToken`. A token is required whenever the
server is reachable from other machines; `om doctor` fails without one on a non-loopback host.

### `bot`

| Key                   | Default                         |                                                                                     |
| --------------------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| `displayName`         | `Open Meetings (assistente IA)` | Name shown in the call                                                              |
| `storageState`        | none                            | Playwright storage state of a dedicated Google account. Guest join without it       |
| `headless`            | `true`                          |                                                                                     |
| `captionsLanguage`    | none                            | Language tag stored on caption segments                                             |
| `captureAudio`        | `false`                         | Also capture the call audio (for STT). Experimental                                 |
| `admissionTimeoutSec` | `300`                           | How long to wait for the host to admit the bot                                      |
| `spawn`               | `true`                          | Start a local bot process on demand. `false` when the bot runs in its own container |
| `token`               | random                          | Shared secret between server and bot (`OM_BOT_TOKEN`)                               |

### `mcp.servers`

MCP servers (stdio) whose tools the agent can use:

```yaml
mcp:
  servers:
    - name: linear
      command: npx
      args: ["-y", "some-linear-mcp"]
      env: { LINEAR_API_KEY: "${LINEAR_API_KEY}" }
      autoApprove: ["list_issues"] # tools that may run without confirmation; "*" for all
```

Tools marked read-only by the server never ask. Everything else asks for confirmation.

### `tools`

`webFetch` (default on, always off in local-only mode) and `acp_agents` (external ACP agents
the agent can delegate to; see docs/integrations/openbot.md).

### `interop`

`agui` (`/agui`), `openai` (`/v1`), `mcp` (`/mcp`), `acp` (the `om acp` command). All enabled by
default; the panel needs `agui`.

### `outputs`

`postSummaryTo: [chat, webhook]` and `webhookUrl`. The webhook receives
`{ event: "meeting.ended", meeting, minutes, state }`.

### `prompts`

Override a built-in prompt with your own Markdown file:
`prompts: { agent: ./my-agent-prompt.md }`. Names: `state-update`, `intent`, `agent`,
`minutes`, `history`. Placeholders such as `{{language}}` keep working.

## Environment overrides

Deployment settings can come from the environment and win over the file:
`OM_HOST`, `OM_PORT`, `OM_AUTH_TOKEN`, `OM_DB_PATH`, `OM_BOT_SPAWN`, `OM_BOT_TOKEN`,
`OM_BOT_HEADLESS`. `OM_CONFIG` picks the file. See `.env.example`.
