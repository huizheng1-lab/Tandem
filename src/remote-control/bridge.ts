import { createHash, randomInt } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { TelegramSessionStream } from "./telegram-session-stream.js";
import type { SessionEventSubscription } from "./streaming-session.js";
import {
  submitRemotePrompt,
  type SessionPromptSubmission
} from "./prompt-submission.js";

export type RemoteCommandVerb = "pair" | "status" | "sessions" | "use" | "pause" | "resume" | "stop" | "confirm-stop" | "revoke" | "unknown";

export interface RemoteCommand {
  verb: RemoteCommandVerb;
  args: string;
}

export interface RemoteInboundMessage {
  updateId: number;
  senderId: number;
  chatId: number;
  username?: string;
  text: string;
  messageId?: number;
  callbackId?: string;
  callbackData?: string;
  replyToMessageId?: number;
}

export interface RemoteTransport {
  start(onMessage: (message: RemoteInboundMessage) => void | Promise<void>, onError?: (error: unknown) => void | Promise<void>): void;
  stop(): void;
  sendMessage(chatId: number, text: string, options?: RemoteSendOptions): Promise<RemoteSentMessage | undefined>;
  editMessage?(chatId: number, messageId: number, text: string, options?: RemoteSendOptions): Promise<void>;
  answerCallback?(callbackId: string, text?: string): Promise<void>;
}

export interface RemoteSendOptions {
  keyboard?: string[][];
  inlineKeyboard?: Array<Array<{ text: string; data: string }>>;
  oneTimeKeyboard?: boolean;
}

export interface RemoteSentMessage {
  messageId?: number;
}

export interface RemoteBridgeConfig {
  enabled?: boolean;
  telegramUserId?: number;
}

export interface RemoteStatusSnapshot {
  sessionId?: string;
  phase: string;
  activeRole?: string;
  runHealth?: string;
  cost: {
    leader: { inputTokens: number; outputTokens: number; dollars: number };
    worker: { inputTokens: number; outputTokens: number; dollars: number };
    cumulative?: {
      leader: { inputTokens: number; outputTokens: number; dollars: number };
      worker: { inputTokens: number; outputTokens: number; dollars: number };
    };
  };
}

export interface RemoteSessionSummary {
  id: string;
  title: string;
  projectDir?: string;
}

export interface RemoteControlActions {
  pause: () => Promise<{ ok: boolean; message: string }>;
  resume: () => Promise<{ ok: boolean; message: string }>;
  stop: () => Promise<{ ok: boolean; message: string }>;
  useSession: (id: string) => Promise<{ ok: boolean; message: string }>;
}

export interface RemoteApprovalRequest {
  id: string;
  kind: "permission" | "plan";
  title: string;
  body: string;
  onResolve: (approved: boolean, source: "telegram" | "timeout") => void;
}

export interface RemoteBridgeDeps {
  auditPath: string;
  transportFactory: (token: string) => RemoteTransport;
  tokenProvider: () => string | undefined;
  statusProvider: () => RemoteStatusSnapshot;
  sessionsProvider: () => Promise<RemoteSessionSummary[]>;
  actions?: RemoteControlActions;
  saveConfig: (patch: RemoteBridgeConfig) => Promise<void>;
  subscribeSessionEvents?: SessionEventSubscription;
  submitPrompt?: SessionPromptSubmission;
  onStateChange?: (state: RemoteControlState) => void;
  now?: () => number;
}

export interface RemoteControlState {
  configured: boolean;
  enabled: boolean;
  polling: boolean;
  paired: boolean;
  pairedUserId?: string;
  pairingCode?: string;
  pairingExpiresAt?: string;
  lastError?: string;
}

interface PairingCode {
  code: string;
  expiresAt: number;
}

interface StopConfirmation {
  nonce: string;
  senderId: number;
  chatId: number;
  expiresAt: number;
  used: boolean;
}

interface PendingRemoteApproval {
  request: RemoteApprovalRequest;
  chatId: number;
  messageId?: number;
  timeout: ReturnType<typeof setTimeout>;
  resolved: boolean;
}

const PAIRING_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 10;
const STOP_CONFIRM_TTL_MS = 60 * 1000;
const REMOTE_APPROVAL_TTL_MS = 5 * 60 * 1000;
const APPROVAL_PREFIX = "approval:";
const MAX_REMOTE_BODY_CHARS = 900;

export function parseRemoteCommand(text: string): RemoteCommand {
  const trimmed = text.trim();
  const match = /^\/([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return { verb: "unknown", args: "" };
  const verb = match[1]?.toLowerCase();
  const args = (match[2] ?? "").trim();
  if (verb === "pair") return /^\d{8}$/.test(args) ? { verb, args } : { verb: "unknown", args };
  if (verb === "use") return /^[A-Za-z0-9-]{1,64}$/.test(args) ? { verb, args } : { verb: "unknown", args };
  if ((verb === "status" || verb === "sessions" || verb === "pause" || verb === "resume" || verb === "stop" || verb === "revoke") && !args) return { verb, args };
  return { verb: "unknown", args };
}

export function parseRemoteMessage(text: string): RemoteCommand {
  const trimmed = text.trim();
  const confirm = /^Confirm STOP\s+([A-Za-z0-9]{6})$/.exec(trimmed);
  if (confirm?.[1]) return { verb: "confirm-stop", args: confirm[1] };
  return parseRemoteCommand(text);
}

export function maskTelegramUserId(id: number | undefined): string | undefined {
  if (!id) return undefined;
  const value = String(id);
  if (value.length <= 4) return `...${value}`;
  return `${value.slice(0, 2)}...${value.slice(-2)}`;
}

export function hashArgs(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export class RemoteBridge {
  private config: RemoteBridgeConfig = {};
  private transport?: RemoteTransport;
  private pairing?: PairingCode;
  private readonly commandTimes: number[] = [];
  private readonly rejectedAuditAt = new Map<number, number>();
  private polling = false;
  private lastError: string | undefined;
  private stopConfirmation?: StopConfirmation;
  private readonly pendingApprovals = new Map<string, PendingRemoteApproval>();
  private readonly sessionStreamsByMessage = new Map<string, TelegramSessionStream>();
  private readonly sessionStreamsBySession = new Map<string, TelegramSessionStream>();
  private readonly selectedSessionsByChat = new Map<number, string>();

  constructor(private readonly deps: RemoteBridgeDeps) {}

  async configure(config: RemoteBridgeConfig): Promise<void> {
    this.config = { ...config };
    await this.restart();
  }

  async enablePairing(): Promise<RemoteControlState> {
    this.config.enabled = true;
    this.pairing = { code: String(randomInt(0, 100000000)).padStart(8, "0"), expiresAt: this.now() + PAIRING_TTL_MS };
    await this.deps.saveConfig({ enabled: true });
    await this.restart();
    this.emitState();
    return this.state();
  }

  async revoke(): Promise<RemoteControlState> {
    await this.audit("revoke", { source: "desktop" });
    this.pairing = undefined;
    this.config = { ...this.config, enabled: false, telegramUserId: undefined };
    await this.deps.saveConfig({ enabled: false, telegramUserId: undefined });
    this.stopTransport();
    this.emitState();
    return this.state();
  }

  state(): RemoteControlState {
    const token = this.deps.tokenProvider();
    const expiresAt = this.pairing?.expiresAt;
    return {
      configured: Boolean(token),
      enabled: Boolean(this.config.enabled),
      polling: this.polling,
      paired: Boolean(this.config.telegramUserId),
      pairedUserId: maskTelegramUserId(this.config.telegramUserId),
      pairingCode: this.pairing && expiresAt && expiresAt > this.now() ? this.pairing.code : undefined,
      pairingExpiresAt: this.pairing && expiresAt && expiresAt > this.now() ? new Date(expiresAt).toISOString() : undefined,
      lastError: this.lastError
    };
  }

  async handleMessage(message: RemoteInboundMessage): Promise<void> {
    if (message.callbackData) {
      await this.handleCallback(message);
      return;
    }
    const command = parseRemoteMessage(message.text);
    await this.audit("inbound", {
      senderId: message.senderId,
      chatId: message.chatId,
      verb: command.verb,
      argsHash: command.args ? hashArgs(command.args) : undefined
    });

    if (command.verb === "pair") {
      await this.handlePair(message, command.args);
      return;
    }

    if (!this.config.telegramUserId || message.senderId !== this.config.telegramUserId) {
      await this.auditRejectedSender(message);
      return;
    }

    if (!this.consumeRateLimit()) {
      await this.send(message.chatId, "Remote control is cooling down; try again in a minute.", "rate-limit");
      return;
    }

    if (command.verb !== "confirm-stop" && command.verb !== "stop") this.stopConfirmation = undefined;

    if (command.verb === "status") {
      await this.send(message.chatId, formatStatus(this.deps.statusProvider()), "status");
      return;
    }
    if (command.verb === "sessions") {
      await this.send(message.chatId, formatSessions(await this.deps.sessionsProvider()), "sessions");
      return;
    }
    if (command.verb === "use") {
      await this.handleUse(message, command.args);
      return;
    }
    if (command.verb === "pause") {
      await this.handleAction(message.chatId, "pause", "pause");
      return;
    }
    if (command.verb === "resume") {
      await this.handleAction(message.chatId, "resume", "resume");
      return;
    }
    if (command.verb === "stop") {
      await this.handleStopRequest(message);
      return;
    }
    if (command.verb === "confirm-stop") {
      await this.handleStopConfirm(message, command.args);
      return;
    }
    if (command.verb === "revoke") {
      await this.send(message.chatId, "Remote control revoked. Pair again from the desktop to re-enable.", "revoke");
      await this.audit("revoke", { source: "telegram", senderId: message.senderId });
      this.pairing = undefined;
      this.config = { ...this.config, enabled: false, telegramUserId: undefined };
      this.selectedSessionsByChat.clear();
      await this.deps.saveConfig({ enabled: false, telegramUserId: undefined });
      this.stopTransport();
      this.emitState();
      return;
    }

    if (/^\/cancel\s*$/i.test(message.text)) {
      await this.handleCancel(message);
      return;
    }
    const promptText = parsePromptText(message.text);
    if (promptText !== undefined || message.replyToMessageId !== undefined) {
      await this.handlePrompt(message, promptText ?? message.text);
      return;
    }

    await this.send(message.chatId, "Supported commands: /status, /sessions, /use <id>, /prompt <text>, /cancel, /pause, /resume, /stop, /revoke", "unknown");
  }

  stop(): void {
    for (const approval of this.pendingApprovals.values()) clearTimeout(approval.timeout);
    this.pendingApprovals.clear();
    this.stopTransport();
  }

  startSessionStream(chatId: number, messageId: number, sessionId: string): boolean {
    const subscribe = this.deps.subscribeSessionEvents;
    const transport = this.transport;
    if (!subscribe || !transport?.editMessage) return false;

    const messageKey = this.streamMessageKey(chatId, messageId);
    this.sessionStreamsByMessage.get(messageKey)?.stop();
    this.sessionStreamsBySession.get(sessionId)?.stop();

    const stream = new TelegramSessionStream({
      chatId,
      messageId,
      sessionId,
      telegram: transport,
      subscribe,
      now: this.deps.now,
      onStopped: (stopped) => {
        if (this.sessionStreamsByMessage.get(messageKey) === stopped) this.sessionStreamsByMessage.delete(messageKey);
        if (this.sessionStreamsBySession.get(sessionId) === stopped) this.sessionStreamsBySession.delete(sessionId);
      }
    });
    this.sessionStreamsByMessage.set(messageKey, stream);
    this.sessionStreamsBySession.set(sessionId, stream);
    stream.start();
    return true;
  }

  stopSessionStream(chatId: number, messageId: number): void {
    this.sessionStreamsByMessage.get(this.streamMessageKey(chatId, messageId))?.stop();
  }

  async pushApproval(request: RemoteApprovalRequest): Promise<boolean> {
    const token = this.deps.tokenProvider();
    const pairedUserId = this.config.telegramUserId;
    if (!this.config.enabled || !token || !pairedUserId || !this.transport) return false;
    const text = formatApprovalRequest(request);
    const sent = await this.transport.sendMessage(pairedUserId, text, {
      inlineKeyboard: [[
        { text: "Approve", data: `${APPROVAL_PREFIX}${request.id}:approve` },
        { text: "Deny", data: `${APPROVAL_PREFIX}${request.id}:deny` }
      ]]
    });
    const timeout = setTimeout(() => {
      const pending = this.pendingApprovals.get(request.id);
      if (!pending || pending.resolved) return;
      pending.resolved = true;
      this.pendingApprovals.delete(request.id);
      void this.audit("approval-timeout", { id: request.id, kind: request.kind });
      request.onResolve(false, "timeout");
      void this.editApprovalMessage(pending, "Timed out after 5 minutes: denied by default.");
    }, REMOTE_APPROVAL_TTL_MS);
    this.pendingApprovals.set(request.id, { request, chatId: pairedUserId, messageId: sent?.messageId, timeout, resolved: false });
    await this.audit("approval-push", { id: request.id, kind: request.kind });
    return true;
  }

  async resolveApproval(id: string, approved: boolean, source: "desktop" | "telegram" | "timeout"): Promise<void> {
    const pending = this.pendingApprovals.get(id);
    if (!pending || pending.resolved) return;
    pending.resolved = true;
    this.pendingApprovals.delete(id);
    clearTimeout(pending.timeout);
    await this.audit("approval-resolved", { id, kind: pending.request.kind, approved, source });
    const verdict = approved ? "approved" : "denied";
    const sourceText = source === "desktop" ? "on desktop" : source === "telegram" ? "from Telegram" : "by timeout";
    await this.editApprovalMessage(pending, `Resolved ${sourceText}: ${verdict}.`);
  }

  private async restart(): Promise<void> {
    this.stopTransport();
    this.lastError = undefined;
    const token = this.deps.tokenProvider();
    if (!this.config.enabled || !token) {
      this.emitState();
      return;
    }
    if (!this.config.telegramUserId && (!this.pairing || this.pairing.expiresAt <= this.now())) {
      this.emitState();
      return;
    }
    this.transport = this.deps.transportFactory(token);
    this.polling = true;
    this.transport.start(
      (message) => this.handleMessage(message),
      (error) => {
        this.lastError = String(error);
        void this.audit("transport-error", { message: this.lastError });
        this.emitState();
      }
    );
    this.emitState();
  }

  private stopTransport(): void {
    for (const stream of [...this.sessionStreamsByMessage.values()]) stream.stop();
    this.sessionStreamsByMessage.clear();
    this.sessionStreamsBySession.clear();
    this.transport?.stop();
    this.transport = undefined;
    this.polling = false;
  }

  private async handlePair(message: RemoteInboundMessage, code: string): Promise<void> {
    if (this.config.telegramUserId && message.senderId !== this.config.telegramUserId) {
      await this.auditRejectedSender(message);
      return;
    }
    if (!this.consumeRateLimit()) {
      await this.send(message.chatId, "Remote control is cooling down; try again in a minute.", "rate-limit");
      return;
    }
    if (!this.pairing || this.pairing.expiresAt <= this.now() || code !== this.pairing.code) {
      await this.audit("pairing-failed", { senderId: message.senderId, reason: "invalid-or-expired" });
      await this.send(message.chatId, "Pairing code is invalid or expired.", "pairing-failed");
      return;
    }
    this.config.telegramUserId = message.senderId;
    this.pairing = undefined;
    await this.deps.saveConfig({ enabled: true, telegramUserId: message.senderId });
    await this.audit("paired", { senderId: message.senderId, username: message.username });
    await this.send(message.chatId, "Tandem remote control paired. Try /status.", "paired");
    this.emitState();
  }

  private async handleCallback(message: RemoteInboundMessage): Promise<void> {
    await this.audit("callback", {
      senderId: message.senderId,
      chatId: message.chatId,
      dataHash: hashArgs(message.callbackData ?? "")
    });
    if (!this.config.telegramUserId || message.senderId !== this.config.telegramUserId) {
      await this.auditRejectedSender(message);
      return;
    }
    if (!this.consumeRateLimit()) {
      if (message.callbackId) await this.transport?.answerCallback?.(message.callbackId, "Remote control is cooling down.");
      return;
    }
    const match = new RegExp(`^${APPROVAL_PREFIX}([^:]+):(approve|deny)$`).exec(message.callbackData ?? "");
    if (!match) {
      if (message.callbackId) await this.transport?.answerCallback?.(message.callbackId, "Unknown remote action.");
      await this.audit("approval-callback", { outcome: "invalid" });
      return;
    }
    const id = match[1] ?? "";
    const approved = match[2] === "approve";
    const pending = this.pendingApprovals.get(id);
    if (!pending || pending.resolved) {
      if (message.callbackId) await this.transport?.answerCallback?.(message.callbackId, "This request is already resolved.");
      await this.audit("approval-callback", { id, outcome: "stale" });
      return;
    }
    await this.resolveApproval(id, approved, "telegram");
    pending.request.onResolve(approved, "telegram");
    if (message.callbackId) await this.transport?.answerCallback?.(message.callbackId, approved ? "Approved." : "Denied.");
  }

  private consumeRateLimit(): boolean {
    const now = this.now();
    while (this.commandTimes.length > 0 && now - (this.commandTimes[0] ?? 0) > RATE_LIMIT_WINDOW_MS) this.commandTimes.shift();
    if (this.commandTimes.length >= RATE_LIMIT_MAX) return false;
    this.commandTimes.push(now);
    return true;
  }

  private async auditRejectedSender(message: RemoteInboundMessage): Promise<void> {
    const now = this.now();
    const last = this.rejectedAuditAt.get(message.senderId) ?? 0;
    if (now - last < RATE_LIMIT_WINDOW_MS) return;
    this.rejectedAuditAt.set(message.senderId, now);
    await this.audit("rejected-sender", { senderId: message.senderId, chatId: message.chatId });
  }

  private async handleAction(chatId: number, action: "pause" | "resume", auditEvent: string): Promise<void> {
    if (!this.deps.actions) {
      await this.audit(auditEvent, { outcome: "unavailable" });
      await this.send(chatId, "Remote control action is unavailable in this build.", auditEvent);
      return;
    }
    const result = await this.deps.actions[action]();
    await this.audit(auditEvent, { outcome: result.ok ? "ok" : "rejected", message: result.message });
    await this.send(chatId, result.message, auditEvent);
  }

  private async handleUse(message: RemoteInboundMessage, prefix: string): Promise<void> {
    const sessions = await this.deps.sessionsProvider();
    const matches = sessions.filter((session) => session.id.toLowerCase().startsWith(prefix.toLowerCase()));
    if (matches.length !== 1) {
      const outcome = matches.length === 0 ? "unmatched" : "ambiguous";
      await this.audit("use", { outcome, prefixHash: hashArgs(prefix), matches: matches.map((session) => session.id.slice(0, 8)) });
      const list = matches.length > 0 ? matches : sessions.slice(0, 5);
      const intro = matches.length === 0 ? `No session matches ${prefix}.` : `Session prefix ${prefix} is ambiguous.`;
      await this.send(message.chatId, `${intro}\n${formatSessions(list)}`, "use-rejected");
      return;
    }
    if (!this.deps.actions) {
      await this.audit("use", { outcome: "unavailable", sessionId: matches[0]?.id });
      await this.send(message.chatId, "Remote session switching is unavailable in this build.", "use");
      return;
    }
    const target = matches[0] as RemoteSessionSummary;
    const result = await this.deps.actions.useSession(target.id);
    if (result.ok) this.selectedSessionsByChat.set(message.chatId, target.id);
    await this.audit("use", { outcome: result.ok ? "ok" : "rejected", sessionId: target.id });
    await this.send(message.chatId, result.message, "use");
  }

  private async handlePrompt(message: RemoteInboundMessage, text: string): Promise<void> {
    const repliedStream = message.replyToMessageId === undefined
      ? undefined
      : this.sessionStreamsByMessage.get(this.streamMessageKey(message.chatId, message.replyToMessageId));
    const sessionId = repliedStream?.sessionId ?? this.selectedSessionsByChat.get(message.chatId);
    if (!sessionId) {
      await this.send(message.chatId, noActiveSessionMessage(), "prompt-no-session");
      return;
    }
    if (!this.deps.submitPrompt) {
      await this.send(message.chatId, "Prompt submission is unavailable in this build.", "prompt-unavailable");
      return;
    }

    const result = await submitRemotePrompt({ chatId: message.chatId, sessionId, text }, this.deps.submitPrompt);
    await this.audit("prompt", { sessionId, outcome: result.status, argsHash: hashArgs(text) });
    const stream = repliedStream ?? this.sessionStreamsBySession.get(sessionId);
    if (result.status === "submitted") {
      if (stream) {
        await stream.resetForSubmission();
        return;
      }
      const sent = await this.transport?.sendMessage(message.chatId, "user / submitting / 0s\nhealthy\nSubmitting prompt...");
      await this.audit("outbound", { chatId: message.chatId, kind: "prompt-submitted" });
      if (sent?.messageId !== undefined && this.startSessionStream(message.chatId, sent.messageId, sessionId)) {
        await this.sessionStreamsByMessage.get(this.streamMessageKey(message.chatId, sent.messageId))?.resetForSubmission();
      }
      return;
    }

    const failure = result.status === "requires-approval"
      ? "Prompt requires approval; approval routing is not enabled for this stream yet."
      : result.message;
    if (stream) await stream.showSubmissionError(failure);
    else await this.send(message.chatId, `Submission failed: ${failure}`, "prompt-failed");
  }

  private async handleCancel(message: RemoteInboundMessage): Promise<void> {
    const repliedStream = message.replyToMessageId === undefined
      ? undefined
      : this.sessionStreamsByMessage.get(this.streamMessageKey(message.chatId, message.replyToMessageId));
    const selectedSession = this.selectedSessionsByChat.get(message.chatId);
    const stream = repliedStream ?? (selectedSession ? this.sessionStreamsBySession.get(selectedSession) : undefined);
    if (!stream) {
      await this.send(message.chatId, noActiveSessionMessage(), "cancel-no-session");
      return;
    }
    const summary = stream.cancellationSummary();
    stream.stop();
    await this.audit("cancel", { sessionId: stream.sessionId, outcome: "stopped" });
    await this.send(message.chatId, summary, "cancel");
  }

  private async handleStopRequest(message: RemoteInboundMessage): Promise<void> {
    const nonce = String(randomInt(0, 1000000)).padStart(6, "0");
    this.stopConfirmation = {
      nonce,
      senderId: message.senderId,
      chatId: message.chatId,
      expiresAt: this.now() + STOP_CONFIRM_TTL_MS,
      used: false
    };
    await this.audit("stop-request", { outcome: "confirmation-required" });
    await this.send(
      message.chatId,
      `Emergency stop requested. Tap Confirm STOP ${nonce} within 60 seconds to stop the current run.`,
      "stop-request",
      { keyboard: [[`Confirm STOP ${nonce}`]], oneTimeKeyboard: true }
    );
  }

  private async handleStopConfirm(message: RemoteInboundMessage, nonce: string): Promise<void> {
    const confirmation = this.stopConfirmation;
    if (!confirmation || confirmation.used || confirmation.senderId !== message.senderId || confirmation.chatId !== message.chatId || confirmation.nonce !== nonce) {
      await this.audit("stop-confirm", { outcome: "rejected", reason: "invalid-or-used" });
      await this.send(message.chatId, "Stop confirmation is invalid or already used. Send /stop to request a fresh confirmation.", "stop-confirm-rejected");
      return;
    }
    if (confirmation.expiresAt <= this.now()) {
      this.stopConfirmation = undefined;
      await this.audit("stop-confirm", { outcome: "rejected", reason: "expired" });
      await this.send(message.chatId, "Stop confirmation expired. Nothing was stopped. Send /stop to request a fresh confirmation.", "stop-confirm-expired");
      return;
    }
    confirmation.used = true;
    this.stopConfirmation = undefined;
    if (!this.deps.actions) {
      await this.audit("stop-confirm", { outcome: "unavailable" });
      await this.send(message.chatId, "Remote stop is unavailable in this build.", "stop-confirm");
      return;
    }
    const result = await this.deps.actions.stop();
    await this.audit("stop-confirm", { outcome: result.ok ? "ok" : "rejected", message: result.message });
    await this.send(message.chatId, result.message, "stop-confirm");
  }

  private async editApprovalMessage(pending: PendingRemoteApproval, resolution: string): Promise<void> {
    if (!pending.messageId || !this.transport?.editMessage) return;
    const text = `${formatApprovalRequest(pending.request)}\n\n${resolution}`;
    await this.transport.editMessage(pending.chatId, pending.messageId, text, { inlineKeyboard: [] });
  }

  private async send(chatId: number, text: string, kind: string, options?: RemoteSendOptions): Promise<void> {
    await this.transport?.sendMessage(chatId, text, options);
    await this.audit("outbound", { chatId, kind });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private emitState(): void {
    this.deps.onStateChange?.(this.state());
  }

  private streamMessageKey(chatId: number, messageId: number): string {
    return `${chatId}:${messageId}`;
  }

  private async audit(event: string, data: Record<string, unknown>): Promise<void> {
    await mkdir(path.dirname(this.deps.auditPath), { recursive: true });
    const line = JSON.stringify({ at: new Date(this.now()).toISOString(), event, ...data });
    await writeFile(this.deps.auditPath, `${line}\n`, { flag: "a" });
  }
}

function parsePromptText(text: string): string | undefined {
  const match = /^\/prompt(?:\s+([\s\S]*))?\s*$/i.exec(text.trim());
  return match ? (match[1] ?? "") : undefined;
}

function noActiveSessionMessage(): string {
  return "No active session. Use /sessions, then /use <id>.";
}

export function formatStatus(status: RemoteStatusSnapshot): string {
  const cumulative = status.cost.cumulative ?? status.cost;
  return [
    `Session: ${status.sessionId ?? "not started"}`,
    `Phase: ${status.phase}`,
    `Active role: ${status.activeRole ?? "none"}`,
    `Run health: ${status.runHealth ?? "unknown"}`,
    `Cost cumulative: leader ${cumulative.leader.inputTokens}/${cumulative.leader.outputTokens} tok $${cumulative.leader.dollars.toFixed(4)}; worker ${cumulative.worker.inputTokens}/${cumulative.worker.outputTokens} tok $${cumulative.worker.dollars.toFixed(4)}`
  ].join("\n");
}

export function formatSessions(sessions: RemoteSessionSummary[]): string {
  if (sessions.length === 0) return "No saved sessions.";
  return sessions.slice(0, 8).map((session) => {
    const project = session.projectDir ? path.basename(session.projectDir) || session.projectDir : "unknown project";
    return `${session.id.slice(0, 8)} - ${session.title || "Untitled session"} - ${project}`;
  }).join("\n");
}

export function formatApprovalRequest(request: RemoteApprovalRequest): string {
  const body = request.body.length <= MAX_REMOTE_BODY_CHARS
    ? request.body
    : `${request.body.slice(0, MAX_REMOTE_BODY_CHARS)}\n[truncated for Telegram]`;
  return [
    request.kind === "plan" ? "Plan confirmation" : "Permission request",
    request.title,
    body
  ].filter(Boolean).join("\n");
}
