import type { ArtifactStore, MeetingSession, ToolDef } from "@open-meetings/core";
import { z } from "zod";

export type ToolResult = { content: string; isError?: boolean };

export type SearchHit = {
  meetingId: string;
  meetingTitle?: string;
  date?: string;
  text: string;
  score: number;
};

/** Semantic search over earlier meetings. Provided by the storage layer. */
export type MeetingSearch = (query: string, limit: number) => Promise<SearchHit[]>;

export type ToolContext = {
  session: MeetingSession;
  runId: string;
  /** Id of the model's tool call being run. */
  callId: string;
  artifacts: ArtifactStore;
  search?: MeetingSearch;
  fetch?: typeof fetch;
};

export type Tool = {
  name: string;
  description: string;
  /** JSON Schema of the arguments, as sent to the model. */
  parameters: Record<string, unknown>;
  /** Validates and normalizes the arguments a model produced. Throws with a readable reason. */
  parse(args: unknown): unknown;
  /**
   * True when the tool acts outside the meeting (creates a card, sends a message). Such a
   * call waits for a person's confirmation unless the config auto-approves it.
   */
  external: boolean;
  /** One line describing a specific call, shown to the person asked to confirm it. */
  summarize(args: unknown): string;
  run(args: unknown, context: ToolContext): Promise<ToolResult>;
};

/** Builds a tool from a zod schema: the schema is both the model-facing contract and the validator. */
export function defineTool<S extends z.ZodType>(spec: {
  name: string;
  description: string;
  schema: S;
  external?: boolean;
  summarize?: (args: z.infer<S>) => string;
  run: (args: z.infer<S>, context: ToolContext) => Promise<ToolResult>;
}): Tool {
  const { $schema: _schema, ...parameters } = z.toJSONSchema(spec.schema) as Record<
    string,
    unknown
  >;
  return {
    name: spec.name,
    description: spec.description,
    parameters,
    external: spec.external ?? false,
    parse(args) {
      const result = spec.schema.safeParse(args);
      if (!result.success) throw new Error(z.prettifyError(result.error));
      return result.data;
    },
    summarize: (args) => spec.summarize?.(args as z.infer<S>) ?? spec.name,
    run: (args, context) => spec.run(args as z.infer<S>, context),
  };
}

export const toToolDef = (tool: Tool): ToolDef => ({
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters,
});
