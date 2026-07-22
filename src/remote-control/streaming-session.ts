export type StreamingHealth = "healthy" | "quiet" | "likely stalled";

export interface StreamingSessionEvent {
  role?: string;
  phase?: string;
  elapsedMs?: number;
  health?: StreamingHealth;
  lastEventKind?: string;
  text?: string;
  ended?: boolean;
}

export interface StreamingSnapshot {
  sessionId: string;
  version: number;
  role: string;
  phase: string;
  elapsedMs: number;
  health: StreamingHealth;
  lastEventKind: string;
  recentText: string[];
  ended: boolean;
}

export type SessionEventSubscription = (
  sessionId: string,
  onEvent: (event: StreamingSessionEvent) => void
) => void | (() => void);

export interface StreamingSessionGatewayOptions {
  sessionId: string;
  subscribe: SessionEventSubscription;
  onSnapshot: (snapshot: StreamingSnapshot) => void;
  onEnd?: () => void;
  now?: () => number;
  throttleMs?: number;
  maxRecentLines?: number;
}

const DEFAULT_THROTTLE_MS = 1_500;
const DEFAULT_MAX_RECENT_LINES = 12;
const TELEGRAM_TEXT_LIMIT = 4_096;

export class StreamingSessionGateway {
  private readonly now: () => number;
  private readonly throttleMs: number;
  private readonly maxRecentLines: number;
  private readonly startedAt: number;
  private readonly recentText: string[] = [];
  private lastTextRole?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private started = false;
  private stopped = false;
  private dirty = false;
  private lastFlushAt?: number;
  private version = 0;
  private role = "unknown";
  private phase = "working";
  private elapsedMs = 0;
  private health: StreamingHealth = "healthy";
  private lastEventKind = "unknown";
  private ended = false;

  constructor(private readonly options: StreamingSessionGatewayOptions) {
    this.now = options.now ?? Date.now;
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.maxRecentLines = options.maxRecentLines ?? DEFAULT_MAX_RECENT_LINES;
    this.startedAt = this.now();
  }

  start(): void {
    if (this.stopped || this.started) return;
    this.started = true;
    const unsubscribe = this.options.subscribe(this.options.sessionId, (event) => this.receive(event));
    if (this.stopped) unsubscribe?.();
    else this.unsubscribe = unsubscribe || undefined;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private receive(event: StreamingSessionEvent): void {
    if (this.stopped) return;
    if (event.role !== undefined) this.role = event.role;
    if (event.phase !== undefined) this.phase = event.phase;
    if (event.elapsedMs !== undefined) this.elapsedMs = Math.max(0, event.elapsedMs);
    else this.elapsedMs = Math.max(0, this.now() - this.startedAt);
    if (event.health !== undefined) this.health = event.health;
    if (event.lastEventKind !== undefined) this.lastEventKind = event.lastEventKind;
    if (event.text) {
      const textRole = event.role ? `${event.role}${event.lastEventKind === "thinking" ? " thinking" : ""}` : "system";
      const canCoalesce = textRole !== "system" && this.lastTextRole === textRole && this.recentText.length > 0;
      if (canCoalesce) {
        this.recentText[this.recentText.length - 1] += event.text;
      } else {
        this.recentText.push(`${textRole}: ${event.text}`);
      }
      this.lastTextRole = textRole;
      if (this.recentText.length > this.maxRecentLines) {
        this.recentText.splice(0, this.recentText.length - this.maxRecentLines);
      }
    }
    this.ended ||= event.ended === true;
    this.dirty = true;

    if (this.ended) {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      if (this.timer) clearTimeout(this.timer);
      const delay = this.lastFlushAt === undefined
        ? 0
        : Math.max(0, this.throttleMs - (this.now() - this.lastFlushAt));
      if (delay === 0) {
        this.finish();
      } else {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.finish();
        }, delay);
      }
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, this.throttleMs);
    }
  }

  private finish(): void {
    this.flush();
    this.stop();
    this.options.onEnd?.();
  }

  private flush(): void {
    if (this.stopped || !this.dirty) return;
    this.dirty = false;
    this.lastFlushAt = this.now();
    this.version += 1;
    this.options.onSnapshot({
      sessionId: this.options.sessionId,
      version: this.version,
      role: this.role,
      phase: this.phase,
      elapsedMs: this.elapsedMs,
      health: this.health,
      lastEventKind: this.lastEventKind,
      recentText: [...this.recentText],
      ended: this.ended
    });
  }
}

export function formatStreamingSnapshot(snapshot: StreamingSnapshot, maxChars = TELEGRAM_TEXT_LIMIT): string {
  const elapsed = formatElapsed(snapshot.elapsedMs);
  const header = `${snapshot.role} / ${snapshot.phase} / ${elapsed}`;
  const health = snapshot.health === "healthy"
    ? "healthy"
    : snapshot.health === "quiet"
      ? `quiet ${Math.floor(snapshot.elapsedMs / 1_000)}s - last event: ${snapshot.lastEventKind}`
      : `likely stalled - last event: ${snapshot.lastEventKind}`;
  const lines = [header, health, ...snapshot.recentText];
  let result = lines.join("\n");
  if (result.length <= maxChars) return result;

  const fixed = `${header}\n${health}\n`;
  const room = Math.max(0, maxChars - fixed.length - 1);
  const body = snapshot.recentText.join("\n");
  result = `${fixed}${body.slice(Math.max(0, body.length - room))}`;
  return result.slice(0, maxChars);
}

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
