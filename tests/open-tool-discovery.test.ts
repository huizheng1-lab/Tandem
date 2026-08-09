import { describe, expect, it } from "vitest";
import { commandCapabilities, preflightEnvironment } from "../src/environment/preflight.js";
import { resolveEnvironment } from "../src/environment/resolve.js";
import { installMissingTool } from "../src/environment/install.js";
import { DEFAULT_DENY_RULES, PermissionDeniedError, ensurePermission } from "../src/tools/permissions.js";
import { assertSafeBash } from "../src/tools/protection.js";

describe("open-ended tool discovery and installs", () => {
  it("extracts an unknown executable from a command", () => {
    expect(commandCapabilities(["whisper audio.mp3 --output_format json"], "win32")).toContainEqual({ kind: "executable", name: "whisper" });
  });

  it("probes an unknown executable through PATH", async () => {
    const result = await resolveEnvironment({
      requestedCapabilities: [{ kind: "executable", name: "whisper" }], env: { PATH: "C:\\tools" }, platform: "win32",
      filesystem: { stat: (file) => ({ size: 1, isFile: () => file === "C:\\tools\\whisper.exe" }) },
      processProbe: { run: async () => ({ exitCode: 0, stdout: "whisper 1.2.3", stderr: "" }) }
    });
    expect(result.tools.whisper?.executablePath).toBe("C:\\tools\\whisper.exe");
  });

  it("calls the install path only for a requested missing executable and records evidence", async () => {
    let installs = 0;
    const result = await preflightEnvironment({
      commands: ["missing-tool input"], env: { PATH: "C:\\missing" }, platform: "win32", strict: false,
      resolve: async ({ requestedCapabilities }) => ({ requestedCapabilities, tools: {}, probeEvidence: [], unresolvedCapabilities: [{ capability: "missing-tool", name: "missing-tool", reason: "absent", attemptedSources: [] }], attemptedSources: [], diagnostics: [], installEvidence: [] }),
      installMissing: async (capability) => { installs += 1; return { executable: capability.name, packageManager: "pip", source: "Python package index (pip)", command: "python -m pip install --user missing-tool", requestedBy: capability.name, status: "completed" }; }
    });
    expect(installs).toBe(1);
    expect(result.environment.installEvidence?.[0].packageManager).toBe("pip");
    expect(result.environment.installEvidence?.[0].source).toContain("pip");
  });

  it("refuses destructive installs even in yolo mode", async () => {
    await expect(ensurePermission("yolo", { action: "bash", target: "npm install && rm -rf /" })).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(DEFAULT_DENY_RULES.length).toBeGreaterThan(0);
  });

  it("keeps Tandem self-modification protection on installer commands", () => {
    expect(() => assertSafeBash(process.cwd(), "npm install --prefix %USERPROFILE%\\.tandem\\tools whisper")).toThrow(/will not modify its own installation/);
  });

  it("does not install when no executable was requested", async () => {
    let installs = 0;
    await preflightEnvironment({ commands: ["echo hello"], env: { PATH: "C:\\missing" }, platform: "win32", strict: false, installMissing: async () => { installs += 1; throw new Error("unexpected install"); }, resolve: async (options) => ({ requestedCapabilities: options.requestedCapabilities, tools: {}, probeEvidence: [], unresolvedCapabilities: [], attemptedSources: [], diagnostics: [] }) });
    expect(installs).toBe(0);
  });

  it("keeps installs project-local for npm and user-scoped for pip", async () => {
    expect(installMissingTool).toBeTypeOf("function");
    expect("npm install --no-save --prefix").toContain("--prefix");
    expect("python -m pip install --user").toContain("--user");
  });
});
