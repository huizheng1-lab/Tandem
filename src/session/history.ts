import type { SessionEvent } from "./store.js";

export interface ConversationHistory {
  text: string;
  priorTurns: number;
  truncated: boolean;
}

interface HistoryTurn {
  user: string;
  outcome?: string;
  error?: boolean;
}

const TURN_LIMIT = 10;
const CHAR_BUDGET = 4000;

function payloadText(payload: unknown, field: "prompt" | "summary" | "text" | "delta"): string | undefined {
  const value = (payload as Record<string, unknown> | undefined)?.[field];
  return typeof value === "string" ? value.trim() : undefined;
}

function payloadRole(payload: unknown): string | undefined {
  const value = (payload as Record<string, unknown> | undefined)?.role;
  return typeof value === "string" ? value : undefined;
}

function isErrorDone(payload: unknown): boolean {
  return Boolean((payload as Record<string, unknown> | undefined)?.error);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatTurn(turn: HistoryTurn, index: number): string {
  const lines = [`Turn ${index}:`, `User: ${oneLine(turn.user)}`];
  if (turn.outcome) lines.push(`${turn.error ? "Outcome (error)" : "Outcome"}: ${oneLine(turn.outcome)}`);
  return lines.join("\n");
}

export function buildConversationHistory(events: SessionEvent[], turnLimit = TURN_LIMIT, charBudget = CHAR_BUDGET): ConversationHistory {
  const turns: HistoryTurn[] = [];
  let current: HistoryTurn | undefined;
  let leaderAnswer = "";
  let compactionSummary = "";

  const finishCurrent = () => {
    if (!current) return;
    if (!current.outcome && leaderAnswer.trim()) current.outcome = leaderAnswer.trim();
    turns.push(current);
    current = undefined;
    leaderAnswer = "";
  };

  for (const event of events) {
    if (event.type === "memory:compaction") {
      finishCurrent();
      const summary = payloadText(event.payload, "summary");
      if (summary) {
        compactionSummary = summary;
        turns.splice(0, turns.length);
      }
      continue;
    }
    if (event.type === "user") {
      finishCurrent();
      const prompt = payloadText(event.payload, "prompt");
      if (prompt) current = { user: prompt };
      continue;
    }
    if (!current) continue;
    if (event.type === "done") {
      const summary = payloadText(event.payload, "summary");
      if (summary) current.outcome = summary;
      current.error = isErrorDone(event.payload);
      finishCurrent();
      continue;
    }
    if (event.type === "text" || event.type === "message") {
      const role = payloadRole(event.payload);
      if (role === "leader" || role === "LEADER") {
        leaderAnswer += payloadText(event.payload, "delta") ?? payloadText(event.payload, "text") ?? "";
      }
    }
  }
  finishCurrent();

  let selected = turns.slice(-turnLimit);
  let truncated = selected.length < turns.length;
  while (selected.length > 0) {
    const body = selected.map((turn, index) => formatTurn(turn, turns.length - selected.length + index + 1)).join("\n\n");
    const prefix = compactionSummary ? `Conversation summary so far:\n${compactionSummary}` : truncated ? "(earlier turns omitted)" : "";
    const text = [prefix, body].filter(Boolean).join("\n\n");
    if (text.length <= charBudget) return { text, priorTurns: turns.length, truncated };
    selected = selected.slice(1);
    truncated = true;
  }

  return { text: compactionSummary ? `Conversation summary so far:\n${compactionSummary}` : truncated ? "(earlier turns omitted)" : "", priorTurns: turns.length, truncated };
}
