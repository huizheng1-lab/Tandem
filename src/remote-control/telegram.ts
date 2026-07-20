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
      const offset = typeof parsed === "number" ? parsed : parsed.offset;
      return normalizeOffset(offset);
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
  private offset = 0;
  private loadedOffset = false;

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly offsetStore?: TelegramOffsetStore
  ) {}

  start(onMessage: (message: RemoteInboundMessage) => void | Promise<void>, onError?: (error: unknown) => void | Promise<void>): void {
    this.stopped = false;
    void this.loop(onMessage, onError);
  }

  stop(): void {
    this.stopped = true;
  }

  async sendMessage(chatId: number, text: string, options?: RemoteSendOptions): Promise<RemoteSentMessage | undefined> {
    const replyMarkup = this.replyMarkup(options);
    const response = await this.fetchImpl(this.url("sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, reply_markup: replyMarkup })
    });
    if (!response.ok) throw new Error(`Telegram sendMessage failed: HTTP ${response.status}`);
    const payload = await response.json() as TelegramSendMessageResponse;
    return { messageId: payload.result?.message_id };
  }

  async editMessage(chatId: number, messageId: number, text: string, options?: RemoteSendOptions): Promise<void> {
    const response = await this.fetchImpl(this.url("editMessageText"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, reply_markup: this.replyMarkup(options) })
    });
    if (!response.ok) throw new Error(`Telegram editMessageText failed: HTTP ${response.status}`);
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    const response = await this.fetchImpl(this.url("answerCallbackQuery"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId, text })
    });
    if (!response.ok) throw new Error(`Telegram answerCallbackQuery failed: HTTP ${response.status}`);
  }

  private async loop(onMessage: (message: RemoteInboundMessage) => void | Promise<void>, onError?: (error: unknown) => void | Promise<void>): Promise<void> {
    await this.loadOffset(onError);
    while (!this.stopped) {
      try {
        const response = await this.fetchImpl(this.url("getUpdates", `timeout=25&offset=${this.offset}`));
        if (!response.ok) throw new Error(`Telegram getUpdates failed: HTTP ${response.status}`);
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
              await onMessage({
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
            await this.persistOffset(onError);
            continue;
          }
          const senderId = update.message?.from?.id;
          const chatId = update.message?.chat?.id;
          const text = update.message?.text;
          if (typeof senderId !== "number" || typeof chatId !== "number" || typeof text !== "string") {
            await this.persistOffset(onError);
            continue;
          }
          await onMessage({
            updateId: update.update_id,
            senderId,
            chatId,
            username: update.message?.from?.username,
            text,
            messageId: update.message?.message_id,
            replyToMessageId: update.message?.reply_to_message?.message_id
          });
          await this.persistOffset(onError);
        }
      } catch (error) {
        await onError?.(error);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  private async loadOffset(onError?: (error: unknown) => void | Promise<void>): Promise<void> {
    if (this.loadedOffset || !this.offsetStore) return;
    this.loadedOffset = true;
    try {
      this.offset = Math.max(this.offset, normalizeOffset(await this.offsetStore.read()));
    } catch (error) {
      await onError?.(error);
    }
  }

  private async persistOffset(onError?: (error: unknown) => void | Promise<void>): Promise<void> {
    if (!this.offsetStore) return;
    try {
      await this.offsetStore.write(this.offset);
    } catch (error) {
      await onError?.(error);
    }
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

function normalizeOffset(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}
