# Writing an engine adapter

Every external engine sits behind an interface in `packages/core/src/llm.ts`:

```ts
interface LlmEngine {
  chat(req: ChatRequest): AsyncIterable<ChatDelta>;
} // tool calling included
interface SttEngine {
  transcribe(chunk: AudioChunk, opts?): Promise<TranscriptSegment[]>;
}
interface TtsEngine {
  synthesize(text: string, opts?): Promise<ReadableStream<Uint8Array>>;
}
interface EmbedEngine {
  embed(texts: string[]): Promise<number[][]>;
}
```

Most providers need no new code: anything that speaks the OpenAI API is covered by the
`openai-compatible` adapters. Write an adapter only for a provider with a different API (as the
native Anthropic adapter does, for prompt caching and tool use).

## Steps

1. **Config.** Add a variant to the provider union in `packages/config/src/schema.ts`
   (for example `provider: z.literal("myprovider")`) with its fields.
2. **Adapter.** Add `packages/engines/src/llm/myprovider.ts` exporting
   `createMyProviderLlm(config, fetchFn)`. Rules:
   - Use the `fetchFn` you are given for every request. It enforces the local-only guarantee;
     calling the global `fetch` would bypass it.
   - Stream: yield `{type: "text"}` as text arrives, `{type: "tool_call"}` for complete tool
     calls, `{type: "usage"}` once, and `{type: "done", finishReason}` last.
   - Never hand over tool calls from a turn cut by a token limit or a refusal.
   - Honor `req.json` (one JSON object as the whole answer) and `req.signal`.
   - Never log the API key. `createLogger` redacts `apiKey`, but keep keys out of messages too.
3. **Factory.** Select it in `createLlm` in `packages/engines/src/factory.ts`. This is the only
   place a provider is chosen.
4. **No native tools?** Set `nativeTools: false`; the factory wraps the engine with
   `withJsonToolFallback`, which describes the tools in the prompt and validates JSON answers.
5. **Doctor.** `om doctor` tests every engine through the interface, so a new adapter is
   covered automatically.
6. **Tests.** Use `fakeFetch` and the stream builders in `packages/engines/src/testing.ts` to
   check the request you send and the deltas you yield. See `engines.test.ts`.

## Pricing

Add the model to `pricing` in your config (USD per 1M tokens) so the cost meter knows it.
