export const MAX_REMOTE_PROMPT_CHARS = 4_000;

export interface PromptSubmissionInput {
  chatId: number;
  sessionId: string;
  text: string;
}

export interface PromptApprovalPayload {
  id: string;
  kind: "permission" | "plan";
  title: string;
  body: string;
}

export type SessionPromptSubmissionResult =
  | { status: "submitted" }
  | { status: "requires-approval"; approval: PromptApprovalPayload }
  | { status: "rejected"; message: string };

export type SessionPromptSubmission = (
  input: PromptSubmissionInput
) => Promise<SessionPromptSubmissionResult>;

export type PromptSubmissionResult =
  | { status: "submitted"; chatId: number; sessionId: string }
  | { status: "requires-approval"; chatId: number; sessionId: string; approval: PromptApprovalPayload }
  | { status: "invalid"; code: "empty" | "too-long" | "control-character"; message: string }
  | { status: "failed"; message: string };

const PROHIBITED_CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export async function submitRemotePrompt(
  input: PromptSubmissionInput,
  submit: SessionPromptSubmission
): Promise<PromptSubmissionResult> {
  const text = input.text.trim();
  if (!text) {
    return { status: "invalid", code: "empty", message: "Prompt cannot be empty." };
  }
  if (text.length > MAX_REMOTE_PROMPT_CHARS) {
    return {
      status: "invalid",
      code: "too-long",
      message: `Prompt is too long (maximum ${MAX_REMOTE_PROMPT_CHARS} characters).`
    };
  }
  if (PROHIBITED_CONTROL_CHARACTER.test(text)) {
    return {
      status: "invalid",
      code: "control-character",
      message: "Prompt contains a prohibited control character."
    };
  }

  try {
    const result = await submit({ ...input, text });
    if (result.status === "submitted") {
      return { status: "submitted", chatId: input.chatId, sessionId: input.sessionId };
    }
    if (result.status === "requires-approval") {
      return {
        status: "requires-approval",
        chatId: input.chatId,
        sessionId: input.sessionId,
        approval: result.approval
      };
    }
    return { status: "failed", message: result.message };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "failed", message: message || "Prompt submission failed." };
  }
}
