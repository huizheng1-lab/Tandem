import type { RemoteInboundMessage, RemoteTransport } from "./bridge.js";

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat?: { id?: number };
    from?: { id?: number; username?: string };
    text?: string;
  };
}

interface TelegramUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
  description?: string;
}

export class TelegramLongPollingTransport implements RemoteTransport {
  private stopped = true;
  private offset = 0;

  constructor(private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}

  start(onMessage: (message: RemoteInboundMessage) => void | Promise<void>, onError?: (error: unknown) => void | Promise<void>): void {
    this.stopped = false;
    void this.loop(onMessage, onError);
  }

  stop(): void {
    this.stopped = true;
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    const response = await this.fetchImpl(this.url("sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    if (!response.ok) throw new Error(`Telegram sendMessage failed: HTTP ${response.status}`);
  }

  private async loop(onMessage: (message: RemoteInboundMessage) => void | Promise<void>, onError?: (error: unknown) => void | Promise<void>): Promise<void> {
    while (!this.stopped) {
      try {
        const response = await this.fetchImpl(this.url("getUpdates", `timeout=25&offset=${this.offset}`));
        if (!response.ok) throw new Error(`Telegram getUpdates failed: HTTP ${response.status}`);
        const payload = await response.json() as TelegramUpdatesResponse;
        if (!payload.ok) throw new Error(payload.description ?? "Telegram getUpdates failed");
        for (const update of payload.result ?? []) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          const senderId = update.message?.from?.id;
          const chatId = update.message?.chat?.id;
          const text = update.message?.text;
          if (typeof senderId !== "number" || typeof chatId !== "number" || typeof text !== "string") continue;
          await onMessage({ updateId: update.update_id, senderId, chatId, username: update.message?.from?.username, text });
        }
      } catch (error) {
        await onError?.(error);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  private url(method: string, query = ""): string {
    return `https://api.telegram.org/bot${this.token}/${method}${query ? `?${query}` : ""}`;
  }
}
