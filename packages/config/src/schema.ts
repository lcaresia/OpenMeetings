import { z } from "zod";

const none = z.object({ provider: z.literal("none") });
const model = z.string().min(1);

const openAiLlm = z.object({
  provider: z.literal("openai-compatible"),
  baseUrl: z.url(),
  model,
  apiKey: z.string().optional(),
  /** "json" = model has no native tool calling; use validated JSON output instead. */
  toolCalling: z.enum(["native", "json"]).default("native"),
  maxTokens: z.coerce.number().int().positive().optional(),
});

const anthropicLlm = z.object({
  provider: z.literal("anthropic"),
  model,
  apiKey: z.string().min(1),
  baseUrl: z.url().optional(),
  maxTokens: z.coerce.number().int().positive().default(16000),
});

export const llmEngineSchema = z.discriminatedUnion("provider", [openAiLlm, anthropicLlm]);

const sttSchema = z.discriminatedUnion("provider", [
  none,
  z.object({
    provider: z.literal("openai-compatible"),
    baseUrl: z.url(),
    model,
    apiKey: z.string().optional(),
    language: z.string().optional(),
  }),
]);

const ttsSchema = z.discriminatedUnion("provider", [
  none,
  z.object({
    provider: z.literal("openai-compatible"),
    baseUrl: z.url(),
    model,
    apiKey: z.string().optional(),
    voice: z.string().default("alloy"),
  }),
]);

const embedSchema = z.discriminatedUnion("provider", [
  none,
  z.object({
    provider: z.literal("openai-compatible"),
    baseUrl: z.url(),
    model,
    apiKey: z.string().optional(),
  }),
]);

const mcpServerSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string().optional()).default({}),
  /** Tool names that may run without human confirmation. "*" approves all. */
  autoApprove: z.array(z.string()).default([]),
});

const acpAgentSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string().optional()).default({}),
  autoApprove: z.boolean().default(false),
});

export const configSchema = z.object({
  /** Free label. "local" additionally blocks every outbound network request. */
  profile: z.string().default("custom"),

  engines: z.object({
    llm: z.object({ fast: llmEngineSchema, smart: llmEngineSchema }),
    stt: sttSchema.default({ provider: "none" }),
    tts: ttsSchema.default({ provider: "none" }),
    embed: embedSchema.default({ provider: "none" }),
  }),

  /** USD per 1M tokens, keyed by model id. Used only by the cost meter. */
  pricing: z
    .record(z.string(), z.object({ in: z.coerce.number().min(0), out: z.coerce.number().min(0) }))
    .default({}),

  network: z
    .object({
      /** Defaults to true when `profile: local`. */
      localOnly: z.boolean().optional(),
    })
    .prefault({}),

  agent: z
    .object({
      name: z.string().default("Open Meetings"),
      wakeWords: z.array(z.string().min(2)).default(["open meetings", "ei open", "hey open"]),
      language: z.string().default("pt-BR"),
      proactive: z.boolean().default(false),
      summaryIntervalSec: z.coerce.number().int().min(5).default(45),
      voiceReplies: z.boolean().default(false),
      maxToolSteps: z.coerce.number().int().min(1).max(50).default(8),
    })
    .prefault({}),

  consent: z
    .object({
      // The bot always identifies itself. `false` is rejected on purpose.
      announceOnJoin: z
        .literal(true, {
          error: "consent.announceOnJoin cannot be disabled: the bot must identify itself",
        })
        .default(true),
      joinMessage: z
        .string()
        .default(
          "Olá, sou o Open Meetings, assistente de IA. Estou transcrevendo esta reunião. Digite 'om sair' para eu sair.",
        ),
      externalGuests: z.enum(["allow", "ask", "leave"]).default("allow"),
      internalDomains: z.array(z.string()).default([]),
      retentionDays: z.coerce.number().int().min(0).default(90),
    })
    .prefault({}),

  storage: z
    .discriminatedUnion("driver", [
      z.object({ driver: z.literal("sqlite"), path: z.string().default("./data/openmeetings.db") }),
      z.object({ driver: z.literal("postgres"), url: z.string().min(1) }),
    ])
    .prefault({ driver: "sqlite" }),

  server: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.coerce.number().int().min(1).max(65535).default(4319),
      /** Single shared token for the panel and API. Required when host is not loopback. */
      authToken: z.string().optional(),
    })
    .prefault({}),

  bot: z
    .object({
      displayName: z.string().default("Open Meetings (assistente IA)"),
      /** Playwright storageState file of a dedicated Google account. Guest join when absent. */
      storageState: z.string().optional(),
      headless: z.boolean().default(true),
      captionsLanguage: z.string().optional(),
      captureAudio: z.boolean().default(false),
      admissionTimeoutSec: z.coerce.number().int().min(10).default(300),
      /**
       * Start a bot process on this machine when a meeting needs one. Turn off when the bot runs
       * elsewhere (its own container) and connects with OM_BOT_TOKEN.
       */
      spawn: z.boolean().default(true),
      /** Shared secret between server and bot. Generated per run when absent and spawn is on. */
      token: z.string().optional(),
    })
    .prefault({}),

  mcp: z.object({ servers: z.array(mcpServerSchema).default([]) }).prefault({}),

  tools: z
    .object({
      webFetch: z.boolean().optional(),
      acp_agents: z.array(acpAgentSchema).default([]),
    })
    .prefault({}),

  interop: z
    .object({
      agui: z
        .object({ enabled: z.boolean().default(true), path: z.string().default("/agui") })
        .prefault({}),
      openai: z
        .object({ enabled: z.boolean().default(true), path: z.string().default("/v1") })
        .prefault({}),
      acp: z.object({ enabled: z.boolean().default(true) }).prefault({}),
    })
    .prefault({}),

  outputs: z
    .object({
      postSummaryTo: z.array(z.enum(["chat", "webhook"])).default(["chat"]),
      webhookUrl: z.url().optional(),
    })
    .prefault({}),

  /** Override built-in prompts: prompt name -> path of a Markdown file. */
  prompts: z.record(z.string(), z.string()).default({}),
});

export type Config = z.infer<typeof configSchema>;
export type ConfigInput = z.input<typeof configSchema>;
export type LlmEngineConfig = z.infer<typeof llmEngineSchema>;
export type SttEngineConfig = Config["engines"]["stt"];
export type TtsEngineConfig = Config["engines"]["tts"];
export type EmbedEngineConfig = Config["engines"]["embed"];
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type AcpAgentConfig = z.infer<typeof acpAgentSchema>;

/** True when no request may leave the machine / private network. */
export function isLocalOnly(config: Pick<Config, "profile" | "network">): boolean {
  return config.network.localOnly ?? config.profile === "local";
}
