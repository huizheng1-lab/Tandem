import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { preflightEnvironment } from "../src/environment/preflight.js";
import { resolveEnvironment } from "../src/environment/resolve.js";
import type { ResolvedEnvironment } from "../src/environment/types.js";

function resolved(overrides: Partial<ResolvedEnvironment> = {}): ResolvedEnvironment {
  return {
    requestedCapabilities: [],
    tools: {},
    probeEvidence: [],
    unresolvedCapabilities: [],
    attemptedSources: [],
    diagnostics: [],
    ...overrides
  };
}

describe("environment preflight integration", () => {
  it("is reachable from the live worker path", () => {
    const live = readFileSync(new URL("../src/agents/live.ts", import.meta.url), "utf8");
    const machine = readFileSync(new URL("../src/orchestrator/machine.ts", import.meta.url), "utf8");
    const verification = readFileSync(new URL("../src/orchestrator/verification.ts", import.meta.url), "utf8");
    const preflight = readFileSync(new URL("../src/environment/preflight.ts", import.meta.url), "utf8");
    expect(live).toContain("preflightEnvironment");
    expect(live).toContain("prepareEnvironment");
    expect(live).toContain("getEnvironment");
    expect(machine).toContain("options.agents.prepareEnvironment");
    expect(machine).toContain("options.agents.getEnvironment");
    expect(verification).toContain("applyResolvedEnvironment");
    expect(preflight).toContain("resolveEnvironment");
  });

  it("uses canonical ffmpeg and ffprobe directories when PATH lookup is empty", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "C:\\missing" };
    const ffmpeg = "C:\\Media\\bin\\ffmpeg.exe";
    const ffprobe = "C:\\Media\\bin\\ffprobe.exe";
    let seen: string[] = [];
    const result = await preflightEnvironment({
      commands: ["ffmpeg -version", "ffprobe -version"],
      env,
      platform: "win32",
      resolve: async (options) => {
        seen = options.requestedCapabilities.map((item) => item.kind);
        return resolved({ tools: {
          ffmpeg: { capability: "ffmpeg", executablePath: ffmpeg, source: "registered-directory" },
          ffprobe: { capability: "ffprobe", executablePath: ffprobe, source: "registered-directory" }
        }});
      }
    });
    // The plan's own capabilities are requested first; the standard toolchain is
    // then attempted opportunistically so ad-hoc worker commands still resolve.
    expect(seen.slice(0, 2)).toEqual(["ffmpeg", "ffprobe"]);
    expect(seen).toContain("node");
    expect(result.env.PATH?.split(";").slice(0, 2)).toEqual(["C:\\Media\\bin", "C:\\missing"]);
  });

  it("resolves ffmpeg even when the BuildPlan never mentions it", async () => {
    // Live failure 2026-08-08: a plan whose verification mentioned only `node`
    // resolved only node, so a worker running ad-hoc ffprobe during a render
    // found nothing and falsely reported the toolchain unavailable.
    const env: NodeJS.ProcessEnv = { PATH: "C:\\missing" };
    let seen: string[] = [];
    const result = await preflightEnvironment({
      commands: ["node scripts/verify.mjs"],
      env,
      platform: "win32",
      resolve: async (options) => {
        seen = options.requestedCapabilities.map((item) => item.kind);
        return resolved({ tools: {
          node: { capability: "node", executablePath: "C:\\nodejs\\node.exe", source: "path" },
          ffmpeg: { capability: "ffmpeg", executablePath: "C:\\Media\\bin\\ffmpeg.exe", source: "registered-directory" },
          ffprobe: { capability: "ffprobe", executablePath: "C:\\Media\\bin\\ffprobe.exe", source: "registered-directory" }
        }});
      }
    });
    expect(seen).toContain("ffmpeg");
    expect(seen).toContain("ffprobe");
    expect(result.environment.tools.ffmpeg?.executablePath).toBe("C:\\Media\\bin\\ffmpeg.exe");
    expect(result.env.PATH).toContain("C:\\Media\\bin");
  });

  it("does not fail a run when an opportunistic runtime is genuinely absent", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "C:\\missing" };
    const result = await preflightEnvironment({
      commands: ["node scripts/verify.mjs"],
      env,
      platform: "win32",
      resolve: async () => resolved({
        tools: { node: { capability: "node", executablePath: "C:\\nodejs\\node.exe", source: "path" } },
        unresolvedCapabilities: [
          { capability: "ffmpeg", name: "ffmpeg", reason: "not installed", attemptedSources: ["path"] },
          { capability: "ffprobe", name: "ffprobe", reason: "not installed", attemptedSources: ["path"] }
        ]
      })
    });
    // ffmpeg was never required by the plan, so its absence must not throw.
    expect(result.environment.tools.node?.executablePath).toBe("C:\\nodejs\\node.exe");
  });

  it("reports a plan-required capability when it is missing without failing the round", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "C:\\missing" };
    const result = await preflightEnvironment({
      commands: ["ffmpeg -i in.mp4 out.mp4"],
      env,
      platform: "win32",
      resolve: async () => resolved({
        tools: {},
        unresolvedCapabilities: [{ capability: "ffmpeg", name: "ffmpeg", reason: "not installed", attemptedSources: ["path"] }]
      })
    });
    expect(result.notFoundCapabilities).toContainEqual(expect.objectContaining({ name: "ffmpeg", reason: "not installed" }));
  });

  it("resolves ffmpeg and ffprobe from a known install directory when PATH misses them", async () => {
    const ffmpeg = "C:\\Media\\bin\\ffmpeg.exe";
    const ffprobe = "C:\\Media\\bin\\ffprobe.exe";
    const result = await preflightEnvironment({
      commands: ["ffmpeg -version", "ffprobe -version"],
      env: { PATH: "C:\\missing" },
      platform: "win32",
      installed: { ffmpegDirectories: ["C:\\Media\\bin"] },
      resolve: (options) => resolveEnvironment({
        ...options,
        filesystem: {
          stat(filePath) {
            if (filePath === ffmpeg || filePath === ffprobe) return { size: 1, isFile: () => true };
            throw new Error("not found");
          }
        },
        processProbe: { run: async () => ({ exitCode: 0, stdout: "ffmpeg version 8.1", stderr: "" }) }
      })
    });
    expect(result.environment.tools.ffmpeg?.executablePath).toBe(ffmpeg);
    expect(result.environment.tools.ffprobe?.executablePath).toBe(ffprobe);
    expect(result.env.PATH?.split(";").slice(0, 2)).toEqual(["C:\\Media\\bin", "C:\\missing"]);
  });

  it("reports one exact reason for a genuinely absent capability", async () => {
    const environment = resolved({ unresolvedCapabilities: [{
      capability: "ffprobe", name: "ffprobe", reason: "No usable ffprobe executable was found", attemptedSources: ["path:C:\\missing"]
    }] });
    const result = await preflightEnvironment({
      commands: ["ffprobe -version"], env: { PATH: "C:\\missing" }, platform: "win32",
      resolve: async () => environment
    });
    expect(result.notFoundCapabilities).toContainEqual(expect.objectContaining({ name: "ffprobe", reason: "No usable ffprobe executable was found" }));
  });
});
