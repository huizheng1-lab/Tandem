import { z } from "zod";

export const PermissionModeSchema = z.enum(["ask", "auto-edit", "yolo"]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const CustomModelSchema = z.object({
  id: z.string().min(1),
  baseURL: z.string().url(),
  apiKeyEnv: z.string().min(1),
  modelName: z.string().min(1),
  contextWindow: z.number().int().positive().optional(),
  costHints: z
    .object({
      inputPerMillion: z.number().nonnegative(),
      outputPerMillion: z.number().nonnegative()
    })
    .optional()
});

export const ConfigSchema = z.object({
  leader: z.string().min(1),
  worker: z.string().min(1),
  maxReviewRounds: z.number().int().min(0),
  permissionMode: PermissionModeSchema,
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
