import { z } from "zod";

export const PermissionModeSchema = z.enum(["ask", "auto-edit", "yolo"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const TriageModeSchema = z.enum(["auto", "always-plan"]);
export type TriageMode = z.infer<typeof TriageModeSchema>;

export const ModelProviderSchema = z.enum(["google", "anthropic", "openai", "openai-compatible", "codex-cli"]);
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
    if (provider !== "codex-cli" && !value.apiKeyEnv) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["apiKeyEnv"],
        message: "apiKeyEnv is required for API-backed custom models"
      });
    }
    if (provider !== "codex-cli" && !value.modelName) {
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

export const ConfigSchema = z.object({
  leader: z.string().min(1),
  worker: z.string().min(1),
  maxReviewRounds: z.number().int().min(0),
  permissionMode: PermissionModeSchema,
  triage: TriageModeSchema,
  codexCliPath: z.string().min(1).optional(),
  showThinking: z.boolean(),
  maxStepsPerAgentTurn: z.number().int().positive(),
  leaderContextBudgetTokens: z.number().int().positive(),
  customModels: z.array(CustomModelSchema)
});

export type TandemConfig = z.infer<typeof ConfigSchema>;
export type CustomModel = z.infer<typeof CustomModelSchema>;

export const EnvSchema = z.record(z.string(), z.string().optional());
export type TandemEnv = z.infer<typeof EnvSchema>;

export const defaultConfig: TandemConfig = {
  leader: "anthropic/claude-fable-5",
  worker: "minimax/minimax-m2.7",
  maxReviewRounds: 3,
  permissionMode: "ask",
  triage: "auto",
  showThinking: false,
  maxStepsPerAgentTurn: 60,
  leaderContextBudgetTokens: 60000,
  customModels: [
    {
      id: "minimax/minimax-m2.7",
      baseURL: "https://api.minimax.io/v1",
      apiKeyEnv: "MINIMAX_API_KEY",
      modelName: "MiniMax-M2.7"
    }
  ]
};

export type ConfigFlags = Partial<Omit<TandemConfig, "customModels">> & {
  customModels?: CustomModel[];
};
