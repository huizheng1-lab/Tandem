import { describe, expect, it } from "vitest";
import { resolveEnvironment, type EnvironmentFileSystem, type EnvironmentProcessProbe } from "../src/environment/resolve.js";
import type { ProcessProbeResult } from "../src/environment/types.js";

const fileSystem = (files: Record<string, number>): EnvironmentFileSystem => ({
  stat(filePath) {
    if (!(filePath in files)) throw new Error("ENOENT");
    return { size: files[filePath], isFile: () => true };
  }
});

const processProbe = (run: (executablePath: string, args: string[]) => ProcessProbeResult): EnvironmentProcessProbe => ({
  async run(executablePath, args) {
    return run(executablePath, args);
  }
});

const success = (stdout = "ok"): ProcessProbeResult => ({ exitCode: 0, stdout, stderr: "" });
const failure = (stderr = "failed"): ProcessProbeResult => ({ exitCode: 1, stdout: "", stderr });

describe("resolveEnvironment", () => {
  it("selects Python by module capability and retains rejection evidence", async () => {
    const py312 = "C:\\Python312\\python.exe";
    const py310 = "C:\\Python310\\python.exe";
    const result = await resolveEnvironment({
      requestedCapabilities: [{ kind: "python", modules: ["edge_tts"] }],
      platform: "win32",
      env: { PATH: "" },
      installed: { python: [py312, py310] },
      filesystem: fileSystem({ [py312]: 100, [py310]: 100 }),
      processProbe: processProbe((executable, args) => {
        if (args[0] === "--version") return success(executable === py312 ? "Python 3.12.4" : "Python 3.10.11");
        return executable === py310 ? success() : failure("No module named edge_tts");
      })
    });

    expect(result.tools.python?.executablePath).toBe(py310);
    expect(result.tools.python?.pythonModules).toEqual(["edge_tts"]);
    expect(result.probeEvidence).toContainEqual(expect.objectContaining({ candidate: py312, accepted: false, failedCapabilities: ["python-module:edge_tts"] }));
    expect(result.unresolvedCapabilities).toEqual([]);
  });

  it("rejects an earlier zero-byte Python placeholder and continues", async () => {
    const placeholder = "C:\\Broken\\python.exe";
    const usable = "C:\\Python311\\python.exe";
    const result = await resolveEnvironment({
      requestedCapabilities: [{ kind: "python" }],
      platform: "win32",
      env: { PATH: "C:\\Broken;C:\\Python311" },
      filesystem: fileSystem({ [placeholder]: 0, [usable]: 500 }),
      processProbe: processProbe(() => success("Python 3.11.9"))
    });

    expect(result.tools.python?.executablePath).toBe(usable);
    expect(result.probeEvidence).toContainEqual(expect.objectContaining({ candidate: placeholder, accepted: false, detail: expect.stringContaining("zero-byte") }));
  });

  it("finds ffprobe in an explicitly registered ffmpeg directory outside PATH", async () => {
    const ffprobe = "D:\\MediaTools\\ffprobe.exe";
    const result = await resolveEnvironment({
      requestedCapabilities: [{ kind: "ffprobe" }],
      platform: "win32",
      env: { PATH: "C:\\Windows" },
      installed: { ffmpegDirectories: ["D:\\MediaTools"] },
      filesystem: fileSystem({ [ffprobe]: 800 }),
      processProbe: processProbe(() => success("ffprobe version 7.1"))
    });

    expect(result.tools.ffprobe).toEqual(expect.objectContaining({ executablePath: ffprobe, source: "registered-directory", version: "7.1" }));
    expect(result.attemptedSources).toContainEqual(expect.objectContaining({ capability: "ffprobe", source: "registered-directory" }));
  });

  it("reports exact missing Python modules instead of claiming Python usable", async () => {
    const python = "C:\\Python312\\python.exe";
    const result = await resolveEnvironment({
      requestedCapabilities: [{ kind: "python", modules: ["edge_tts", "numpy"] }],
      platform: "win32",
      env: { PATH: "" },
      installed: { python: [python] },
      filesystem: fileSystem({ [python]: 100 }),
      processProbe: processProbe((_executable, args) => args[0] === "--version" ? success("Python 3.12.4") : args[1]?.includes("numpy") ? success() : failure("No module named edge_tts"))
    });

    expect(result.tools.python).toBeUndefined();
    expect(result.unresolvedCapabilities).toEqual([expect.objectContaining({ capability: "python", name: "python-module:edge_tts", reason: expect.stringContaining("edge_tts") })]);
  });

  it("records a bounded declared-host network failure without remediation", async () => {
    const calls: Array<{ host: string; timeoutMs: number }> = [];
    const result = await resolveEnvironment({
      requestedCapabilities: [{ kind: "network-host", host: "api.example.test" }],
      probeTimeoutMs: 1234,
      networkProbe: {
        async probe(host, options) {
          calls.push({ host, timeoutMs: options.timeoutMs });
          return { ok: false, detail: "DNS lookup timed out" };
        }
      }
    });

    expect(calls).toEqual([{ host: "api.example.test", timeoutMs: 1234 }]);
    expect(result.unresolvedCapabilities).toEqual([expect.objectContaining({ name: "network-host:api.example.test", reason: expect.stringContaining("DNS lookup timed out") })]);
    expect(result.probeEvidence[0]).toEqual(expect.objectContaining({ source: "network", accepted: false }));
  });

  it("discovers the installed Codex sandbox helper and rejects a zero-byte helper", async () => {
    const broken = "C:\\CodexOld\\codex-windows-sandbox.exe";
    const usable = "C:\\CodexNew\\codex-windows-sandbox.exe";
    const result = await resolveEnvironment({
      requestedCapabilities: [{ kind: "codex-sandbox-helper" }],
      platform: "win32",
      env: { PATH: "" },
      installed: { codexDirectories: ["C:\\CodexOld", "C:\\CodexNew"] },
      filesystem: fileSystem({ [broken]: 0, [usable]: 900 }),
      processProbe: processProbe(() => success("codex-windows-sandbox 1.2.0"))
    });

    expect(result.tools["codex-sandbox-helper"]?.executablePath).toBe(usable);
    expect(result.probeEvidence).toContainEqual(expect.objectContaining({ candidate: broken, accepted: false, detail: expect.stringContaining("zero-byte") }));
  });

  it("rejects unusable Node and ffmpeg probes and records later usable absolute paths", async () => {
    const badNode = "C:\\BadNode\\node.exe";
    const goodNode = "C:\\Node\\node.exe";
    const badFfmpeg = "C:\\BadMedia\\ffmpeg.exe";
    const goodFfmpeg = "C:\\Media\\ffmpeg.exe";
    const result = await resolveEnvironment({
      requestedCapabilities: [{ kind: "node", minimumVersion: "20.0.0" }, { kind: "ffmpeg" }],
      platform: "win32",
      env: { PATH: "" },
      installed: { node: [badNode, goodNode], ffmpeg: [badFfmpeg, goodFfmpeg] },
      filesystem: fileSystem({ [badNode]: 100, [goodNode]: 100, [badFfmpeg]: 100, [goodFfmpeg]: 100 }),
      processProbe: processProbe((executable) => {
        if (executable === badNode) return success("v18.20.0");
        if (executable === goodNode) return success("v22.3.0");
        if (executable === badFfmpeg) return failure("missing DLL");
        return success("ffmpeg version 7.0.2");
      })
    });

    expect(result.tools.node?.executablePath).toBe(goodNode);
    expect(result.tools.ffmpeg?.executablePath).toBe(goodFfmpeg);
    expect(result.probeEvidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidate: badNode, accepted: false }),
      expect.objectContaining({ candidate: badFfmpeg, accepted: false })
    ]));
  });

  it("rejects successful executable probes that do not identify a versioned runtime", async () => {
    const invalidNode = "C:\\InvalidNode\\node.exe";
    const validNode = "C:\\Node\\node.exe";
    const result = await resolveEnvironment({
      requestedCapabilities: [{ kind: "node" }],
      platform: "win32",
      env: { PATH: "" },
      installed: { node: [invalidNode, validNode] },
      filesystem: fileSystem({ [invalidNode]: 100, [validNode]: 100 }),
      processProbe: processProbe((executable) => success(executable === invalidNode ? "ok" : "v22.3.0"))
    });

    expect(result.tools.node?.executablePath).toBe(validNode);
    expect(result.probeEvidence).toContainEqual(expect.objectContaining({
      candidate: invalidNode,
      accepted: false,
      failedCapabilities: ["node-version"],
      detail: expect.stringContaining("did not report a recognizable node version")
    }));
  });

  it("never selects an ambiguous launcher override", async () => {
    const python = "C:\\Python310\\python.exe";
    const result = await resolveEnvironment({
      requestedCapabilities: [{ kind: "python" }],
      overrides: { python: "py -3" },
      installed: { python: [python] },
      platform: "win32",
      env: { PATH: "" },
      filesystem: fileSystem({ [python]: 100 }),
      processProbe: processProbe(() => success("Python 3.10.11"))
    });

    expect(result.tools.python?.executablePath).toBe(python);
    expect(result.probeEvidence).toContainEqual(expect.objectContaining({ candidate: "py -3", accepted: false, detail: expect.stringContaining("ambiguous launcher") }));
  });
});
