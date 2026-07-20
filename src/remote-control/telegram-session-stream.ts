import type { RemoteTransport } from "./bridge.js";
import {
  StreamingSessionGateway,
  formatStreamingSnapshot,
  type SessionEventSubscription,
  type StreamingSnapshot
} from "./streaming-session.js";

export interface TelegramSessionStreamOptions {
  chatId: number;
  messageId: number;
  sessionId: string;
  telegram: Pick<RemoteTransport, "editMessage">;
  subscribe: SessionEventSubscription;
  onEdited?: (stream: TelegramSessionStream) => void;
  onError?: (stream: TelegramSessionStream, error: unknown) => void;
  onStopped?: (stream: TelegramSessionStream) => void;
  now?: () => number;
  throttleMs?: number;
}

export class TelegramSessionStream {
  private readonly gateway: StreamingSessionGateway;
  private stopped = false;
  private editing = false;
  private pending?: StreamingSnapshot;
  private pendingText?: string;
  private appliedVersion = 0;
  private lastSnapshot?: StreamingSnapshot;
  private finishing = false;

  constructor(private readonly options: TelegramSessionStreamOptions) {
    this.gateway = new StreamingSessionGateway({
      sessionId: options.sessionId,
      subscribe: options.subscribe,
      now: options.now,
      throttleMs: options.throttleMs,
      onSnapshot: (snapshot) => this.enqueue(snapshot),
      onEnd: () => this.finishAfterDrain()
    });
  }

  start(): void {
    if (this.stopped) return;
    this.gateway.start();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.finishing = false;
    this.pending = undefined;
    this.pendingText = undefined;
    this.gateway.stop();
    this.options.onStopped?.(this);
  }

  get sessionId(): string {
    return this.options.sessionId;
  }

  async resetForSubmission(): Promise<void> {
    const snapshot = this.lastSnapshot;
    const role = snapshot?.role ?? "user";
    this.pending = undefined;
    this.pendingText = `${role} / submitting / 0s\nhealthy\nSubmitting prompt...`;
    await this.drain();
  }

  async showSubmissionError(message: string): Promise<void> {
    const base = this.lastSnapshot
      ? formatStreamingSnapshot(this.lastSnapshot)
      : `user / submitting / 0s\nhealthy`;
    const footer = `Submission failed: ${oneLine(message)}`;
    this.pending = undefined;
    this.pendingText = `${base}\n${footer}`;
    await this.drain();
  }

  cancellationSummary(): string {
    const snapshot = this.lastSnapshot;
    if (!snapshot) return `Cancelled ${this.options.sessionId}; no stream updates received.`;
    const health = snapshot.health === "quiet"
      ? `quiet; last event ${snapshot.lastEventKind}`
      : snapshot.health === "likely stalled"
        ? `likely stalled; last event ${snapshot.lastEventKind}`
        : "healthy";
    return `Cancelled ${this.options.sessionId}: ${snapshot.role} / ${snapshot.phase}; ${health}.`;
  }

  private enqueue(snapshot: StreamingSnapshot): void {
    if (this.stopped || snapshot.version <= this.appliedVersion) return;
    this.lastSnapshot = snapshot;
    this.pending = snapshot;
    this.pendingText = undefined;
    void this.drain();
  }

  private finishAfterDrain(): void {
    if (this.stopped) return;
    this.finishing = true;
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.editing || this.stopped) return;
    this.editing = true;
    try {
      while (!this.stopped && (this.pendingText !== undefined || this.pending)) {
        const text = this.pendingText;
        const snapshot = text === undefined ? this.pending : undefined;
        this.pendingText = undefined;
        if (snapshot) this.pending = undefined;
        if (snapshot && snapshot.version <= this.appliedVersion) continue;
        const edit = this.options.telegram.editMessage;
        if (!edit) {
          this.options.onError?.(this, new Error("Telegram transport does not support message edits."));
          this.stop();
          return;
        }
        try {
          await edit.call(
            this.options.telegram,
            this.options.chatId,
            this.options.messageId,
            text ?? formatStreamingSnapshot(snapshot as StreamingSnapshot)
          );
          if (snapshot) this.appliedVersion = snapshot.version;
          this.options.onEdited?.(this);
        } catch (error) {
          this.options.onError?.(this, error);
          this.stop();
          return;
        }
      }
    } finally {
      this.editing = false;
      if (this.finishing && !this.stopped && this.pendingText === undefined && !this.pending) this.stop();
    }
  }
}

function oneLine(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 240) || "Unknown error";
}
