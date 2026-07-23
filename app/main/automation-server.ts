import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionResumeResponse, SessionStartResponse } from "../shared/ipc.js";

export interface AutomationService {
  startSession(request: { projectDir?: string }): Promise<SessionStartResponse>;
  resumeSession(id: string): Promise<SessionResumeResponse>;
  run(prompt: string): Promise<void>;
  getAutomationState(): { projectDir: string; sessionId?: string; running: boolean };
}

export interface AutomationServerOptions {
  port: number;
  tokenFile: string;
  projectDir: string;
  instanceId?: string;
  service: AutomationService;
}

export interface AutomationServerHandle {
  port: number;
  tokenFile: string;
  close(): Promise<void>;
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(payload));
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.byteLength;
    if (size > 16_384) throw new Error("Automation request is too large.");
    chunks.push(value);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sameProject(left: string, right: string): boolean {
  const normalize = (value: string) => path.resolve(value).replace(/[\\/]+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}

export async function startAutomationServer(options: AutomationServerOptions): Promise<AutomationServerHandle> {
  const token = randomBytes(32).toString("hex");
  const allowedProjectDir = path.resolve(options.projectDir);
  let acceptedAt: string | undefined;
  let completedAt: string | undefined;
  let lastError: string | undefined;
  let activeRun: Promise<void> | undefined;
  let completedRun: { projectDir: string; sessionId?: string } | undefined;

  const runtimeBuildInfo = async () => {
    const buildInfoPath = process.env.TANDEM_RUNTIME_BUILD_INFO;
    if (!buildInfoPath) return {};
    try {
      const parsed = JSON.parse(await readFile(buildInfoPath, "utf8")) as Record<string, unknown>;
      return {
        runtimeBuildInfoPath: buildInfoPath,
        sourceSha: typeof parsed.sourceSha === "string" ? parsed.sourceSha : undefined,
        packageIdentity: typeof parsed.packageIdentity === "string" ? parsed.packageIdentity : process.env.TANDEM_RUNTIME_PACKAGE_ID,
        capabilities: parsed.reciprocalCapabilities && typeof parsed.reciprocalCapabilities === "object"
          ? parsed.reciprocalCapabilities
          : { candidatePreviewArtifactLifecycle: 1 }
      };
    } catch (error) {
      return {
        runtimeBuildInfoPath: buildInfoPath,
        packageIdentity: process.env.TANDEM_RUNTIME_PACKAGE_ID,
        runtimeBuildInfoError: error instanceof Error ? error.message : String(error),
        capabilities: { candidatePreviewArtifactLifecycle: 1 }
      };
    }
  };

  const currentState = () => {
    const serviceState = options.service.getAutomationState();
    if (!serviceState.running) completedRun = undefined;
    const serviceMatchesCompletedRun = Boolean(
      completedRun
      && completedRun.sessionId
      && serviceState.sessionId === completedRun.sessionId
      && sameProject(serviceState.projectDir, completedRun.projectDir)
    );
    return {
      serviceState,
      running: Boolean(activeRun) || (serviceState.running && !serviceMatchesCompletedRun)
    };
  };

  const server = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${token}`) {
        return send(response, 401, { error: "Invalid automation token." });
      }
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/status") {
        const state = currentState();
        const runtime = await runtimeBuildInfo();
        return send(response, 200, {
          ok: true,
          pid: process.pid,
          instanceId: options.instanceId || null,
          allowedProjectDir,
          tokenFile: options.tokenFile,
          ...state.serviceState,
          ...runtime,
          capabilities: runtime.capabilities || { candidatePreviewArtifactLifecycle: 1 },
          running: state.running,
          acceptedAt,
          completedAt,
          lastError
        });
      }
      if (request.method !== "POST") return send(response, 404, { error: "Not found." });
      const input = await requestBody(request);
      const requestedProject = typeof input.projectDir === "string" ? input.projectDir : allowedProjectDir;
      if (!sameProject(requestedProject, allowedProjectDir)) {
        return send(response, 403, { error: `Automation is restricted to ${allowedProjectDir}.` });
      }
      if (url.pathname === "/session") {
        const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
        const session = sessionId
          ? await options.service.resumeSession(sessionId)
          : await options.service.startSession({ projectDir: allowedProjectDir });
        return send(response, 200, { ok: true, sessionId: "sessionId" in session ? session.sessionId : session.id, projectDir: session.projectDir });
      }
      if (url.pathname === "/prompt") {
        const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
        if (!prompt || prompt.length > 20_000) return send(response, 400, { error: "Prompt must be between 1 and 20000 characters." });
        const state = currentState();
        if (state.running) return send(response, 409, { error: "A Tandem run is already active." });
        let current = state.serviceState;
        if (!current.sessionId || !sameProject(current.projectDir, allowedProjectDir)) {
          await options.service.startSession({ projectDir: allowedProjectDir });
          current = options.service.getAutomationState();
        }
        acceptedAt = new Date().toISOString();
        completedAt = undefined;
        lastError = undefined;
        completedRun = undefined;
        const runProjectDir = current.projectDir;
        const runSessionId = current.sessionId;
        let rejectedBecauseAlreadyActive = false;
        activeRun = Promise.resolve()
          .then(() => options.service.run(prompt))
          .catch((error: unknown) => {
            lastError = error instanceof Error ? error.message : String(error);
            rejectedBecauseAlreadyActive = /already active/i.test(lastError);
          })
          .finally(() => {
            completedAt = new Date().toISOString();
            activeRun = undefined;
            if (!rejectedBecauseAlreadyActive) completedRun = { projectDir: runProjectDir, sessionId: runSessionId };
          });
        return send(response, 202, { ok: true, accepted: true, projectDir: allowedProjectDir, acceptedAt });
      }
      return send(response, 404, { error: "Not found." });
    } catch (error) {
      return send(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Automation server did not expose a TCP port.");
  await mkdir(path.dirname(options.tokenFile), { recursive: true });
  await writeFile(options.tokenFile, `${JSON.stringify({
    port: address.port,
    token,
    pid: process.pid,
    instanceId: options.instanceId || null,
    projectDir: allowedProjectDir,
    createdAt: new Date().toISOString()
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  return {
    port: address.port,
    tokenFile: options.tokenFile,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(options.tokenFile, { force: true });
    }
  };
}
