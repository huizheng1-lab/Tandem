import type { MachineEvent } from "../orchestrator/machine.js";
import type { RunnerMessage } from "../agents/runner.js";
import type { SessionEvent } from "./store.js";

function textField(payload: unknown, field: string): string | undefined {
  const value = (payload as Record<string, unknown> | undefined)?.[field];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function payloadRole(payload: unknown): string | undefined {
  const value = (payload as Record<string, unknown> | undefined)?.role;
  return typeof value === "string" ? value : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function stripEmbeddedHistoryDigest(content: string): string {
  return content.replace(/^Compact session-log history:\n[\s\S]*?\n\n(?=Request:)/, "");
}

export function rebuildLeaderThread(events: SessionEvent[]): RunnerMessage[] {
  const messages: RunnerMessage[] = [];

  for (const event of events) {
    if (event.type === "memory:compaction") {
      const summary = textField(event.payload, "summary");
      if (summary) {
        messages.splice(0, messages.length, { role: "assistant", content: `Conversation summary so far:\n${summary}` });
      }
      continue;
    }

    if (event.type === "user") {
      const prompt = textField(event.payload, "prompt");
      if (prompt) {
        const stripped = stripEmbeddedHistoryDigest(prompt);
        messages.push({ role: "user", content: stripped.startsWith("Request:") ? stripped : `Request:\n${stripped}` });
      }
      continue;
    }

    if (event.type === "text" && payloadRole(event.payload) === "leader") {
      const delta = textField(event.payload, "delta");
      if (!delta) continue;
      const last = messages.at(-1);
      if (last?.role === "assistant") last.content += delta;
      else messages.push({ role: "assistant", content: delta });
      continue;
    }

    if (event.type === "machine") {
      const machine = event.payload as MachineEvent;
      if (machine?.type === "artifact" && (machine.name === "BuildPlan" || machine.name === "ReviewVerdict" || machine.name === "TakeoverReport")) {
        messages.push({ role: "assistant", content: `Submitted ${machine.name}:\n${safeJson(machine.value)}` });
      }
      continue;
    }

    if (event.type === "done") {
      const summary = textField(event.payload, "summary");
      if (summary) messages.push({ role: "assistant", content: summary });
    }
  }

  return messages;
}
