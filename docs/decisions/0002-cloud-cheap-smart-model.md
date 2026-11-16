# 0002: `cloud-cheap` uses a small model for the smart tier

Status: accepted

## Context

The spec's sample `cloud-cheap` config pairs Groq `llama-3.1-8b-instant` (fast) with a Claude
Sonnet model (smart), and sets a target of under US$ 0.05 per meeting hour. With the workload
model in `packages/engines/src/cost.ts` (80 fast calls, 6 commands and one set of minutes per
hour), a Sonnet-class smart model at US$ 2 / 10 per 1M tokens costs about US$ 0.15 per hour on
its own. The two requirements contradict each other.

## Decision

`examples/cloud-cheap.yaml` uses `claude-haiku-5-5` (US$ 0.10 / 0.50) as the smart model:
about US$ 0.018 per hour in total. A test asserts the profile stays under US$ 0.05.
Sonnet-class and frontier models live in `hybrid.yaml` and `cloud-best.yaml`.

Anthropic engines are called through the official `@anthropic-ai/sdk` (Messages API,
streaming). Sampling parameters are never sent to them: current Claude models reject them.

## Consequences

The cost target is met by a shipped, tested profile. Users who want a stronger smart model
change one line and see the new cost in `om doctor`.
