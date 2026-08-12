import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RemoteInboundMessage, RemoteSendOptions, RemoteSentMessage, RemoteTransport } from "./bridge.js";

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    chat?: { id?: number };
    from?: { id?: number; username?: string };
    text?: string;
    reply_to_message?: { message_id?: number };
  };
  callback_query?: {
    id?: string;
    data?: string;
    from?: { id?: number; username?: string };
    message?: {
      message_id?: number;
      chat?: { id?: number };
    };
  };
}

interface TelegramUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
  description?: string;
}

interface TelegramSendMessageResponse {
  ok: boolean;
  result?: { message_id?: number };
}

export interface TelegramOffsetStore {
  read(): Promise<number>;
  write(offset: number): Promise<void>;
}

export class FileTelegramOffsetStore implements TelegramOffsetStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<number> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as { offset?: unknown } | number;
      return normalizeOffset(typeof parsed === "number" ? parsed : parsed.offset);
    } catch {
      return 0;
    }
  }

  async write(offset: number): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify({ offset: normalizeOffset(offset) })}\n`, "utf8");
  }
}

export class TelegramLongPollingTransport implements RemoteTransport {
  private stopped = true;
  private unsubscribe?: () => void;
  private static readonly pollers = new Map<string, TelegramPoller>();

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly offsetStore?: TelegramOffsetStore
  ) {}

  start(onMessage: (message: RemoteInboundMessage) => void | Promise<void>, onError?: (error: unknown) => void | Promise<void>): void {
    this.stop();
    this.stopped = false;
    let poller = TelegramLongPollingTransport.pollers.get(this.token);
    if (!poller) {
      poller = new TelegramPoller(this.token, this.fetchImpl, this.offsetStore, () => {
        if (TelegramLongPollingTransport.pollers.get(this.token) === poller) {
          TelegramLongPollingTransport.pollers.delete(this.token);
        }
      });
      TelegramLongPollingTransport.pollers.set(this.token, poller);
    }
    this.unsubscribe = poller.subscribe(onMessage, onError);
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  async sendMessage(chatId: number, text: string, options?: RemoteSendOptions): Promise<RemoteSentMessage | undefined> {
    const replyMarkup = this.replyMarkup(options);
    const response = await this.fetchImpl(this.url("sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, reply_markup: replyMarkup })
    });
    if (!response.ok) throw await telegramHttpError(response, "sendMessage");
    const payload = await response.json() as TelegramSendMessageResponse;
    return { messageId: payload.result?.message_id };
  }

  async editMessage(chatId: number, messageId: number, text: string, options?: RemoteSendOptions): Promise<void> {
    const response = await this.fetchImpl(this.url("editMessageText"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, reply_markup: this.replyMarkup(options) })
    });
    if (!response.ok) throw await telegramHttpError(response, "editMessageText");
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    const response = await this.fetchImpl(this.url("answerCallbackQuery"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId, text })
    });
    if (!response.ok) throw await telegramHttpError(response, "answerCallbackQuery");
  }

  private url(method: string, query = ""): string {
    return `https://api.telegram.org/bot${this.token}/${method}${query ? `?${query}` : ""}`;
  }

  private replyMarkup(options?: RemoteSendOptions): unknown {
    if (options?.inlineKeyboard) {
      return { inline_keyboard: options.inlineKeyboard.map((row) => row.map((button) => ({ text: button.text, callback_data: button.data }))) };
    }
    if (options?.keyboard) {
      return { keyboard: options.keyboard.map((row) => row.map((label) => ({ text: label }))), one_time_keyboard: options.oneTimeKeyboard ?? true, resize_keyboard: true };
    }
    return undefined;
  }

}

class TelegramPoller {
  private stopped = true;
  private offset = 0;
  private loadedOffset = false;
  private readonly subscribers = new Map<number, { onMessage: (message: RemoteInboundMessage) => void | Promise<void>; onError?: (error: unknown) => void | Promise<void> }>();
  private nextSubscriber = 0;

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch,
    private readonly offsetStore?: TelegramOffsetStore,
    private readonly onEmpty?: () => void
  ) {}

  subscribe(onMessage: (message: RemoteInboundMessage) => void | Promise<void>, onError?: (error: unknown) => void | Promise<void>): () => void {
    const id = this.nextSubscriber++;
    this.subscribers.set(id, { onMessage, onError });
    if (this.stopped) {
      this.stopped = false;
      void this.loop();
    }
    return () => {
      this.subscribers.delete(id);
      if (this.subscribers.size === 0) {
        this.stopped = true;
        this.onEmpty?.();
      }
    };
  }

  private async loop(): Promise<void> {
    await this.loadOffset();
    while (!this.stopped) {
      try {
        const response = await this.fetchImpl(this.url("getUpdates", `timeout=25&offset=${this.offset}`));
        if (!response.ok) throw await telegramHttpError(response, "getUpdates");
        const payload = await response.json() as TelegramUpdatesResponse;
        if (!payload.ok) throw new Error(payload.description ?? "Telegram getUpdates failed");
        for (const update of payload.result ?? []) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          const callback = update.callback_query;
          if (callback) {
            const senderId = callback.from?.id;
            const chatId = callback.message?.chat?.id;
            const data = callback.data;
            if (typeof senderId === "number" && typeof chatId === "number" && typeof data === "string") {
              await this.dispatch({
                updateId: update.update_id,
                senderId,
                chatId,
                username: callback.from?.username,
                text: "",
                messageId: callback.message?.message_id,
                callbackId: callback.id,
                callbackData: data
              });
            }
            await this.persistOffset();
            continue;
          }
          const senderId = update.message?.from?.id;
          const chatId = update.message?.chat?.id;
          const text = update.message?.text;
          if (typeof senderId !== "number" || typeof chatId !== "number" || typeof text !== "string") {
            await this.persistOffset();
            continue;
          }
          await this.dispatch({
            updateId: update.update_id,
            senderId,
            chatId,
            username: update.message?.from?.username,
            text,
            messageId: update.message?.message_id,
            replyToMessageId: update.message?.reply_to_message?.message_id
          });
          await this.persistOffset();
        }
      } catch (error) {
        await Promise.allSettled([...this.subscribers.values()].map((subscriber) => Promise.resolve(subscriber.onError?.(error))));
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  private async dispatch(message: RemoteInboundMessage): Promise<void> {
    const deliveries = [...this.subscribers.values()];
    const results = await Promise.allSettled(deliveries.map((subscriber) => Promise.resolve(subscriber.onMessage(message))));
    await Promise.allSettled(results.map((result, index) => result.status === "rejected"
      ? Promise.resolve(deliveries[index]?.onError?.(result.reason))
      : Promise.resolve()));
  }

  private async loadOffset(): Promise<void> {
    if (this.loadedOffset || !this.offsetStore) return;
    this.loadedOffset = true;
    try {
      this.offset = Math.max(this.offset, normalizeOffset(await this.offsetStore.read()));
    } catch { /* polling remains usable when offset persistence is unavailable */ }
  }

  private async persistOffset(): Promise<void> {
    if (!this.offsetStore) return;
    try {
      await this.offsetStore.write(this.offset);
    } catch { /* delivery must not stop because persistence failed */ }
  }

  private url(method: string, query = ""): string {
    return `https://api.telegram.org/bot${this.token}/${method}${query ? `?${query}` : ""}`;
  }

}

function normalizeOffset(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

async function telegramHttpError(response: Response, method: string): Promise<Error> {
  let description = "";
  try {
    const payload = await response.json() as { description?: unknown };
    description = typeof payload.description === "string" ? payload.description.trim() : "";
  } catch {
    description = "";
  }
  return new Error(`Telegram ${method} failed: HTTP ${response.status}${description ? `: ${description}` : ""}`);
}
