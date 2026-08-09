import { describe, expect, it } from "vitest";
import { commandCapabilities, preflightEnvironment } from "../src/environment/preflight.js";
import { resolveEnvironment } from "../src/environment/resolve.js";
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

  it("keeps shell and arbitrary command names out of strict requirements", async () => {
    const result = await preflightEnvironment({
      commands: ["powershell -NoProfile -File verify.ps1", "cmd /c echo ok", "bash script.sh", "git status"],
      env: { PATH: "C:\\missing" }, platform: "win32",
      resolve: async (options) => ({ requestedCapabilities: options.requestedCapabilities, tools: {}, probeEvidence: [], unresolvedCapabilities: options.requestedCapabilities.map((capability) => ({ capability: capability.kind === "executable" ? capability.name : capability.kind, name: capability.kind, reason: "absent", attemptedSources: [] })), attemptedSources: [], diagnostics: [] })
    });
    expect(result.requiredCapabilities).toEqual([]);
  });

  it("accepts a PATH executable when its generic version probe exits non-zero", async () => {
    const result = await resolveEnvironment({
      requestedCapabilities: [{ kind: "executable", name: "powershell" }], env: { PATH: "C:\\tools" }, platform: "win32",
      filesystem: { stat: () => ({ size: 1, isFile: () => true }) },
      processProbe: { run: async () => ({ exitCode: 1, stdout: "", stderr: "unknown option" }) }
    });
    expect(result.tools.powershell?.version).toBeUndefined();
  });

  it("canonicalizes foo.exe and foo to one discovered capability", () => {
    expect(commandCapabilities(["foo.exe", "foo"], "win32")).toEqual([{ kind: "executable", name: "foo" }]);
  });

  it("reports a requested missing executable without invoking an installer", async () => {
    const result = await preflightEnvironment({
      commands: ["missing-tool input"], env: { PATH: "C:\\missing" }, platform: "win32",
      resolve: async ({ requestedCapabilities }) => ({ requestedCapabilities, tools: {}, probeEvidence: [], unresolvedCapabilities: [{ capability: "missing-tool", name: "missing-tool", reason: "absent", attemptedSources: [] }], attemptedSources: [], diagnostics: [] })
    });
    expect(result.notFoundCapabilities).toContainEqual(expect.objectContaining({ name: "missing-tool" }));
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
    await preflightEnvironment({ commands: ["echo hello"], env: { PATH: "C:\\missing" }, platform: "win32", resolve: async (options) => ({ requestedCapabilities: options.requestedCapabilities, tools: {}, probeEvidence: [], unresolvedCapabilities: [], attemptedSources: [], diagnostics: [] }) });
    expect(installs).toBe(0);
  });

});
