const UNSAFE_PROMPT_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const PROVIDER_INTERLEAVE_MARKUP = /\]<\][^\r\n[\]]{1,80}\[>\[/g;
const TOOL_CALL_BLOCK = /<tool_call>[\s\S]*?(?:<\/tool_call>|(?=\r?\n|$))/gi;

export function sanitizePromptText(value: string): string {
  return value.replace(UNSAFE_PROMPT_CONTROL_CHARS, "");
}

export function sanitizeModelOutputText(value: string): string {
  return sanitizePromptText(value)
    .replace(TOOL_CALL_BLOCK, "")
    .replace(PROVIDER_INTERLEAVE_MARKUP, "")
    .replace(/[ \t]+\r?\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function sanitizePromptValue<T>(value: T): T {
  if (typeof value === "string") return sanitizePromptText(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizePromptValue(item)) as T;
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) result[key] = sanitizePromptValue(item);
  return result as T;
}
