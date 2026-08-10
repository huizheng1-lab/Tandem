/** Decision order for conflicts between user intent and orchestration conveniences. */
export const DECISION_PRECEDENCE =
  "1. hard safety boundaries (destructive-command blacklist and self-modification protection); 2. explicit user instructions (including task prompts and referenced instruction files); 3. plan-derived acceptance criteria; 4. orchestrator-internal optimisations and defaults (including artifact reuse).";

const regenerationVerb = /\b(?:re[- ]?generate|regenerat(?:e|ion|ing)|re[- ]?render|rebuild|redo)\b/i;
const freshOutput = /\b(?:fresh|from scratch|new output|do not reuse|don't reuse|without reuse|no reuse)\b/i;
export interface RegenerationDecision { required: boolean; reason?: string }
export function regenerationDecision(request: string, instructionText = "", planText = ""): RegenerationDecision {
  if (regenerationVerb.test(request)) return { required: true, reason: "explicit user instruction contains a regeneration verb" };
  if (freshOutput.test(instructionText)) return { required: true, reason: "referenced project instruction requires fresh output" };
  if (regenerationVerb.test(planText) || freshOutput.test(planText)) return { required: true, reason: "the explicit freshness requirement was carried into the build plan" };
  return { required: false };
}
export function regenerationNotice(decision: RegenerationDecision): string | undefined {
  return decision.required && decision.reason ? `Artifact reuse was bypassed because ${decision.reason}; existing artifacts do not satisfy the explicit instruction.` : undefined;
}
