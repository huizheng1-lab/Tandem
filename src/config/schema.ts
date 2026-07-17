import { z } from "zod";

export const PermissionModeSchema = z.enum(["ask", "auto-edit", "yolo"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const TriageModeSchema = z.enum(["auto", "always-plan"]);
export type TriageMode = z.infer<typeof TriageModeSchema>;

export const CodexCliReasoningEffortSchema = z.enum(["minimal", "low", "medium", "high"]);
export type CodexCliReasoningEffort = z.infer<typeof CodexCliReasoningEffortSchema>;

export const DesktopThemeSchema = z.enum(["auto", "light", "dark"]);
export type DesktopTheme = z.infer<typeof DesktopThemeSchema>;

export const ModelProviderSchema = z.enum(["google", "anthropic", "openai", "openai-compatible", "codex-cli", "claude-code-cli"]);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

export const CustomModelSchema = z
  .object({
    id: z.string().min(1),
    provider: ModelProviderSchema.optional(),
    baseURL: z.string().url().optional(),
    apiKeyEnv: z.string().min(1).optional(),
    modelName: z.string().min(1).optional(),
    contextWindow: z.number().int().positive().optional(),
    media: z.object({ images: z.boolean().optional(), pdf: z.boolean().optional() }).optional(),
    costHints: z
      .object({
        inputPerMillion: z.number().nonnegative(),
        outputPerMillion: z.number().nonnegative()
      })
      .optional()
  })
  .superRefine((value, ctx) => {
    const provider = value.provider ?? "openai-compatible";
    if (provider !== "codex-cli" && provider !== "claude-code-cli" && !value.apiKeyEnv) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apiKeyEnv"],
        message: "apiKeyEnv is required for API-backed custom models"
      });
    }
    if (provider !== "codex-cli" && provider !== "claude-code-cli" && !value.modelName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["modelName"],
        message: "modelName is required for API-backed custom models"
      });
    }
    if (provider === "openai-compatible" && !value.baseURL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseURL"],
        message: "baseURL is required for openai-compatible custom models"
      });
    }
  });

export const RemoteControlConfigSchema = z.object({
  enabled: z.boolean().optional(),
  telegramUserId: z.number().int().positive().optional()
});
export type RemoteControlConfig = z.infer<typeof RemoteControlConfigSchema>;

export const ConfigSchema = z.object({
  leader: z.string().min(1),
  worker: z.string().min(1),
  maxReviewRounds: z.number().int().min(0),
  permissionMode: PermissionModeSchema,
  triage: TriageModeSchema,
  codexCliPath: z.string().min(1).optional(),
  claudeCliPath: z.string().min(1).optional(),
  codexCliModel: z.string().min(1).optional(),
  claudeCliModel: z.string().min(1).optional(),
  codexCliReasoningEffort: CodexCliReasoningEffortSchema.optional(),
  showThinking: z.boolean(),
  desktopTheme: DesktopThemeSchema,
  maxStepsPerAgentTurn: z.number().int().positive(),
  leaderContextBudgetTokens: z.number().int().positive(),
  // D68-2: per-call safety cap on claude-code-cli internal spending. Real incident (D66's
  // live evidence) showed a single planning call cost $1.17 over 36 internal turns before
  // hitting an unrelated failure - there's no current ceiling. A normal single call should
  // never legitimately need to exceed $2; if it does, the call stops with a diagnosable error
  // rather than running away.
  claudeMaxBudgetUsdPerCall: z.number().positive(),
  // D54: cap on concurrent stream workers. At 1 (default) even multi-stream plans run
  // sequentially - zero risk to existing users. >1 enables real concurrency, capped at
  // that many simultaneous workers. Streams beyond the cap are scheduled as earlier ones
  // finish. Settable like maxReviewRounds.
  maxParallelWorkers: z.number().int().min(1),
  remoteControl: RemoteControlConfigSchema.optional(),
  customModels: z.array(CustomModelSchema)
});

export type TandemConfig = z.infer<typeof ConfigSchema>;
export type CustomModel = z.infer<typeof CustomModelSchema>;

export const EnvSchema = z.record(z.string(), z.string().optional());
export type TandemEnv = z.infer<typeof EnvSchema>;

export const defaultConfig: TandemConfig = {
  leader: "anthropic/claude-fable-5",
  worker: "minimax/minimax-m3",
  maxReviewRounds: 3,
  permissionMode: "ask",
  triage: "auto",
  showThinking: false,
  desktopTheme: "auto",
  maxStepsPerAgentTurn: 150,
  leaderContextBudgetTokens: 60000,
  claudeMaxBudgetUsdPerCall: 2.0,
  maxParallelWorkers: 2,
  customModels: [
    {
      id: "minimax/minimax-m2.7",
      baseURL: "https://api.minimax.io/v1",
      apiKeyEnv: "MINIMAX_API_KEY",
      modelName: "MiniMax-M2.7"
    },
    {
      id: "minimax/minimax-m3",
      baseURL: "https://api.minimax.io/v1",
      apiKeyEnv: "MINIMAX_API_KEY",
      modelName: "MiniMax-M3",
      // MiniMax's published standard M3 tier is $0.30/M input and $1.20/M output up to
      // 512k input tokens; long-context and priority tiers cost more, which this simple
      // hint structure cannot yet express.
      costHints: { inputPerMillion: 0.3, outputPerMillion: 1.2 }
    }
  ]
};

export type ConfigFlags = Partial<Omit<TandemConfig, "customModels">> & {
  customModels?: CustomModel[];
};
