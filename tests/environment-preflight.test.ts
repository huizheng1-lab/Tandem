import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { preflightEnvironment, EnvironmentPreflightError } from "../src/environment/preflight.js";
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
    const preflight = readFileSync(new URL("../src/environment/preflight.ts", import.meta.url), "utf8");
    expect(live).toContain("preflightEnvironment");
    expect(live).toContain("prepareEnvironment");
    expect(machine).toContain("options.agents.prepareEnvironment");
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
    expect(seen).toEqual(["ffmpeg", "ffprobe"]);
    expect(result.env.PATH?.split(";").slice(0, 2)).toEqual(["C:\\Media\\bin", "C:\\missing"]);
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

  it("reports one exact blocker for a genuinely absent capability", async () => {
    const environment = resolved({ unresolvedCapabilities: [{
      capability: "ffprobe", name: "ffprobe", reason: "No usable ffprobe executable was found", attemptedSources: ["path:C:\\missing"]
    }] });
    await expect(preflightEnvironment({
      commands: ["ffprobe -version"], env: { PATH: "C:\\missing" }, platform: "win32",
      resolve: async () => environment
    })).rejects.toThrow("missing ffprobe");
    try {
      await preflightEnvironment({ commands: ["ffprobe -version"], env: { PATH: "C:\\missing" }, platform: "win32", resolve: async () => environment });
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentPreflightError);
      expect((error as EnvironmentPreflightError).message).toContain("No usable ffprobe executable was found");
    }
  });
});
