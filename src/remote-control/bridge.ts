import { createHash, randomInt } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

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
}

export interface RemoteTransport {
  start(onMessage: (message: RemoteInboundMessage) => void | Promise<void>, onError?: (error: unknown) => void | Promise<void>): void;
  stop(): void;
  sendMessage(chatId: number, text: string, options?: RemoteSendOptions): Promise<void>;
}

export interface RemoteSendOptions {
  keyboard?: string[][];
  oneTimeKeyboard?: boolean;
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

export interface RemoteBridgeDeps {
  auditPath: string;
  transportFactory: (token: string) => RemoteTransport;
  tokenProvider: () => string | undefined;
  statusProvider: () => RemoteStatusSnapshot;
  sessionsProvider: () => Promise<RemoteSessionSummary[]>;
  actions?: RemoteControlActions;
  saveConfig: (patch: RemoteBridgeConfig) => Promise<void>;
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

const PAIRING_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 10;
const STOP_CONFIRM_TTL_MS = 60 * 1000;

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
      await this.deps.saveConfig({ enabled: false, telegramUserId: undefined });
      this.stopTransport();
      this.emitState();
      return;
    }

    await this.send(message.chatId, "Supported commands: /status, /sessions, /use <id>, /pause, /resume, /stop, /revoke", "unknown");
  }

  stop(): void {
    this.stopTransport();
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
    await this.audit("use", { outcome: result.ok ? "ok" : "rejected", sessionId: target.id });
    await this.send(message.chatId, result.message, "use");
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

  private async audit(event: string, data: Record<string, unknown>): Promise<void> {
    await mkdir(path.dirname(this.deps.auditPath), { recursive: true });
    const line = JSON.stringify({ at: new Date(this.now()).toISOString(), event, ...data });
    await writeFile(this.deps.auditPath, `${line}\n`, { flag: "a" });
  }
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
