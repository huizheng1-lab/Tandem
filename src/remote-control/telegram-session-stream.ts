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
  onStopped?: (stream: TelegramSessionStream) => void;
  now?: () => number;
  throttleMs?: number;
}

export class TelegramSessionStream {
  private readonly gateway: StreamingSessionGateway;
  private stopped = false;
  private editing = false;
  private pending?: StreamingSnapshot;
  private appliedVersion = 0;

  constructor(private readonly options: TelegramSessionStreamOptions) {
    this.gateway = new StreamingSessionGateway({
      sessionId: options.sessionId,
      subscribe: options.subscribe,
      now: options.now,
      throttleMs: options.throttleMs,
      onSnapshot: (snapshot) => this.enqueue(snapshot),
      onEnd: () => this.stop()
    });
  }

  start(): void {
    if (this.stopped) return;
    this.gateway.start();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pending = undefined;
    this.gateway.stop();
    this.options.onStopped?.(this);
  }

  private enqueue(snapshot: StreamingSnapshot): void {
    if (this.stopped || snapshot.version <= this.appliedVersion) return;
    this.pending = snapshot;
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.editing || this.stopped) return;
    this.editing = true;
    try {
      while (!this.stopped && this.pending) {
        const snapshot = this.pending;
        this.pending = undefined;
        if (snapshot.version <= this.appliedVersion) continue;
        const edit = this.options.telegram.editMessage;
        if (!edit) {
          this.stop();
          return;
        }
        try {
          await edit.call(this.options.telegram, this.options.chatId, this.options.messageId, formatStreamingSnapshot(snapshot));
          this.appliedVersion = snapshot.version;
        } catch {
          this.stop();
          return;
        }
      }
    } finally {
      this.editing = false;
    }
  }
}
