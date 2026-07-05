export interface LoopSpec {
  intervalMs: number;
  prompt: string;
}

export function parseInterval(value: string): number {
  const match = /^(\d+)(s|m|h)$/.exec(value);
  if (!match) throw new Error("Use intervals like 30s, 5m, or 2h.");
  const amount = Number(match[1]);
  const unit = match[2];
  return amount * (unit === "s" ? 1000 : unit === "m" ? 60000 : 3600000);
}

export function parseLoop(args: string[]): LoopSpec | "stop" {
  if (args[0] === "stop") return "stop";
  if (args.length < 2) throw new Error("Usage: /loop <30s|5m|2h> <prompt>");
  return { intervalMs: parseInterval(args[0] ?? ""), prompt: args.slice(1).join(" ") };
}
