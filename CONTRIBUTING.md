# Contributing

Thanks for helping. The most valuable contributions right now are, in order: fixing the Meet
bot when Google changes the page, new fixtures (recorded meetings with expected notes),
platform adapters, and engine adapters.

## Setup

Node 22+ and pnpm (`corepack enable`).

```bash
pnpm install
pnpm --filter @open-meetings/bot exec playwright install chromium
./scripts/check.sh      # format, lint, typecheck, tests, build
```

Try it without any API key:

```bash
pnpm build
node apps/server/dist/main.js serve --demo weekly-sync --mock
```

then open http://localhost:4319.

## Ground rules

- **Simplicity first.** Before adding a dependency, check whether 30 lines of code do the job.
  No Redis, Kafka or Kubernetes in the default path.
- **Every external engine behind an interface**, chosen by config. No provider hardcoded.
- **Never invent an API.** Read the official documentation (or the installed type definitions)
  before calling an external API, and say where you checked in the PR.
- **Decisions that go against the spec or are hard to reverse** get a short ADR in
  `docs/decisions/NNNN-title.md`.
- **Tests come with the change.** Unit tests next to the code (`*.test.ts`, Vitest). Pipeline
  behavior through fixtures (`fixtures/<name>/captions.json` + `expected.json`).
- **TypeScript strict**, Biome for format and lint, Conventional Commits.
- **No secrets and no meeting content** in code, tests, fixtures or logs.

## Fixing the Meet bot

1. Find what changed with `pnpm --filter @open-meetings/bot smoke` (needs `OM_SMOKE_MEET_URL`)
   or by inspecting the page in a real call.
2. Change only `apps/bot/src/meet/selectors.ts`. Keep the old selector as a fallback when you
   can: not every account sees the new UI at the same time.
3. Update `apps/bot/test/fake-meet.html` so the tests model the new DOM, and run
   `pnpm exec vitest run apps/bot`.

## Adding a fixture

A fixture is a fake meeting: `fixtures/<name>/captions.json` (timed captions, joins, chat) and
`fixtures/<name>/expected.json` (decisions, action items with owner and due date, open
questions, commands and what their replies must contain). `pnpm eval` scores any model against
all fixtures; `pnpm eval --mock` is what CI runs. Write fixtures in any language; invent the
people and the content.

## Pull requests

Small and focused. Describe what changed and how you tested it. CI must be green.
