const UNSAFE_PROMPT_CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

export function sanitizePromptText(value: string): string {
  return value.replace(UNSAFE_PROMPT_CONTROL_CHARS, "");
}

export function sanitizePromptValue<T>(value: T): T {
  if (typeof value === "string") return sanitizePromptText(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizePromptValue(item)) as T;
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) result[key] = sanitizePromptValue(item);
  return result as T;
}
