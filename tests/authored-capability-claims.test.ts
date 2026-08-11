import { describe, expect, it } from "vitest";
import {
  validateAuthoredCapabilityContradictions,
  validateRecordedCapabilityContradictions,
  type AuthoredFileContent
} from "../src/orchestrator/artifacts.js";
import type { BuildPlan, CompletionReport } from "../src/orchestrator/artifacts.js";

const plan: BuildPlan = {
  title: "media build",
  objective: "Assemble media using the ffmpeg tool.",
  constraints: [],
  tasks: [{ id: "T1", description: "Use ffmpeg and ffprobe to inspect clips." }],
  acceptanceCriteria: [],
  verification: []
};

const report = (summary: string): CompletionReport => ({
  status: "complete",
  summary,
  taskResults: [{ id: "T1", status: "done" }],
  filesChanged: ["work/build.py"],
  verificationResults: [],
  deviationsFromPlan: []
});

describe("authored capability contradiction guard", () => {
  it("rejects an unusable executable claim and quotes the authored use line", () => {
    const file: AuthoredFileContent = {
      path: "work/build.py",
      content: 'FFMPEG = r"C:\\tools\\ffmpeg.exe"\nsubprocess.run([FFMPEG, "-version"])'
    };
    expect(() => validateAuthoredCapabilityContradictions(plan, report("ffmpeg is not usable here"), [file]))
      .toThrow(/work\/build\.py.*FFMPEG.*ffmpeg\.exe/);
  });

  it("does nothing when no authored file is supplied", () => {
    expect(() => validateAuthoredCapabilityContradictions(plan, report("ffmpeg is not usable here"), [])).not.toThrow();
  });

  it("uses the claimed subject even when the plan never names it", () => {
    const offPlan: BuildPlan = { ...plan, objective: "Assemble media with the ComfyUI runtime." };
    const file: AuthoredFileContent = {
      path: "work/build.py",
      content: 'PYTHON = r"C:\\tools\\python.exe"\nsubprocess.run([PYTHON, "--version"])'
    };
    expect(() => validateAuthoredCapabilityContradictions(offPlan, report("python is missing"), [file]))
      .toThrow(/python\.exe/);
  });

  it("ignores comments and captured error output", () => {
    const file: AuthoredFileContent = {
      path: "work/log.txt",
      content: "# ffmpeg.exe is not usable here\nerror output: ffmpeg.exe could not start"
    };
    expect(() => validateAuthoredCapabilityContradictions(plan, report("ffmpeg is not usable here"), [file])).not.toThrow();
  });

  it("ignores reports without capability claims", () => {
    const file: AuthoredFileContent = {
      path: "work/build.py",
      content: 'FFMPEG = r"C:\\tools\\ffmpeg.exe"'
    };
    expect(() => validateAuthoredCapabilityContradictions(plan, report("assembled the clips"), [file])).not.toThrow();
  });

  it.each([
    ['{"audio": "C:\\\\tmp\\\\sound.mp3"}'],
    ['const report = "ffmpeg.exe failed to start";'],
    ['const input = "C:\\\\tools\\\\ffmpeg.exe";']
  ])("does not treat authored data as capability use: %s", (content) => {
    expect(() => validateAuthoredCapabilityContradictions(plan, report("ffmpeg is unusable"), [{ path: "work/report.json", content }])).not.toThrow();
  });

  it("still rejects an authored invocation", () => {
    expect(() => validateAuthoredCapabilityContradictions(plan, report("ffmpeg is unusable"), [{
      path: "work/build.py",
      content: 'subprocess.run(["ffmpeg.exe", "-version"])'
    }])).toThrow();
  });
});

describe("recorded capability contradiction guard", () => {
  const blocked = (summary: string, command: string, output: string, passed = true): CompletionReport => ({
    ...report(summary),
    status: "blocked",
    verificationResults: [{ command, passed, output }]
  });

  it("does not treat presence probes as functional success", () => {
    expect(validateRecordedCapabilityContradictions(plan, blocked("ComfyUI is stalled", 'Test-Path -LiteralPath "C:\\ComfyUI"', "True"))).toEqual([]);
    expect(validateRecordedCapabilityContradictions(plan, blocked("ComfyUI is stalled", 'Get-ChildItem "C:\\ComfyUI"', "Directory: C:\\ComfyUI"))).toEqual([]);
  });

  it("does treat a successful version invocation as a contradiction", () => {
    expect(validateRecordedCapabilityContradictions(plan, blocked("ffmpeg is unusable", "ffmpeg --version", "ffmpeg version 7.0"))).toHaveLength(1);
  });
});
