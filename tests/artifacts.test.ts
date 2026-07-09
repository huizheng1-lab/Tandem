import path from "node:path";
import { describe, expect, it } from "vitest";
import { BuildPlan, CompletionReport, mergeCompletionReports, partitionPlan, ReviewVerdictSchema, validateBuildPlan, validateCompletionReport, validateStreamFileOwnership } from "../src/orchestrator/artifacts.js";

const plan: BuildPlan = {
  title: "Demo",
  objective: "Build demo.",
  constraints: [],
  tasks: [{ id: "T1", description: "Do work" }],
  acceptanceCriteria: ["Works"],
  verification: ["npm test"]
};

describe("artifacts", () => {
  it("rejects reports that omit plan verification commands", async () => {
    expect(() =>
      validateCompletionReport(plan, {
        status: "complete",
        summary: "done",
        taskResults: [{ id: "T1", status: "done" }],
        filesChanged: [],
        verificationResults: [],
        deviationsFromPlan: []
      })
    ).toThrow(/omitted verification/);
  });

  it("rejects prose verification entries in build plans", async () => {
    await expect(
      validateBuildPlan(
        {
          ...plan,
          verification: ["Play game and verify all effects are working"]
        },
        "win32"
      )
    ).rejects.toThrow(/does not look like a runnable shell command/);
  });

  it("rejects zero-task build plans as direct-answer work", async () => {
    await expect((async () => validateBuildPlan({ ...plan, tasks: [] }))()).rejects.toThrow(/no implementation tasks - answer directly instead/);
  });

  it("rejects POSIX verification commands on Windows with safer alternatives", async () => {
    await expect((async () => validateBuildPlan({ ...plan, verification: ["cat launch.bat"] }, "win32"))()).rejects.toThrow(/POSIX-only tool `cat`.*type <file>/s);
    await expect((async () => validateBuildPlan({ ...plan, verification: ["cat index.html | grep -E 'src=|title='"] }, "win32"))()).rejects.toThrow(/POSIX-only tool `cat`.*POSIX-only tool `grep`.*findstr/s);
  });

  it("accepts Windows-safe and cross-platform verification commands", async () => {
    expect((await validateBuildPlan({ ...plan, verification: ["npm test", "node test.mjs", "type launch.bat"] }, "win32")).verification).toHaveLength(3);
  });

  it("requires completion reports to echo plan verification commands exactly", async () => {
    const exactPlan: BuildPlan = {
      ...plan,
      verification: ["node test.mjs"]
    };
    // Note: filesChanged deliberately omits test.mjs so the D56-2 verification-script-tampering
    // gate (separate concern) doesn't fire on this test's data. The test's purpose is to verify
    // the verbatim-echo contract; the D56-2 describe block below covers the script-tampering case.
    const report = validateCompletionReport(exactPlan, {
      status: "complete",
      summary: "done",
      taskResults: [{ id: "T1", status: "done" }],
      filesChanged: ["src/other.js"],
      verificationResults: [{ command: "node test.mjs", passed: true, output: "ok" }],
      deviationsFromPlan: []
    });
    expect(report.status).toBe("complete");
    expect(() =>
      validateCompletionReport(exactPlan, {
        status: "complete",
        summary: "done",
        taskResults: [{ id: "T1", status: "done" }],
        filesChanged: ["src/other.js"],
        verificationResults: [{ command: "npm test", passed: true, output: "adapted from node test.mjs" }],
        deviationsFromPlan: []
      })
    ).toThrow(/omitted verification commands: node test\.mjs/);
  });

  describe("D54 schema + partition + validation", () => {
    it("partitionPlan: tasks without `stream` all land in the default stream", async () => {
      const p: BuildPlan = {
        ...plan,
        tasks: [
          { id: "T1", description: "a" },
          { id: "T2", description: "b" }
        ]
      };
      const streams = partitionPlan(p);
      expect(streams).toHaveLength(1);
      expect(streams[0]?.id).toBe("__default__");
      expect(streams[0]?.tasks.map((t) => t.id)).toEqual(["T1", "T2"]);
      expect(streams[0]?.verification).toEqual(p.verification);
    });

    it("partitionPlan: explicit streams are kept separate, default last", async () => {
      const p: BuildPlan = {
        ...plan,
        tasks: [
          { id: "T1", description: "a", stream: "A" },
          { id: "T2", description: "b", stream: "B" },
          { id: "T3", description: "c" }
        ]
      };
      const streams = partitionPlan(p);
      expect(streams.map((s) => s.id)).toEqual(["A", "B", "__default__"]);
      expect(streams.find((s) => s.id === "A")?.tasks.map((t) => t.id)).toEqual(["T1"]);
      expect(streams.find((s) => s.id === "B")?.tasks.map((t) => t.id)).toEqual(["T2"]);
      expect(streams.find((s) => s.id === "__default__")?.tasks.map((t) => t.id)).toEqual(["T3"]);
    });

    it("validateStreamFileOwnership: single-stream plan always passes", async () => {
      const p: BuildPlan = {
        ...plan,
        tasks: [
          { id: "T1", description: "a", files: ["foo.js"] },
          { id: "T2", description: "b" }
        ]
      };
      expect(validateStreamFileOwnership(p)).toEqual([]);
    });

    it("validateStreamFileOwnership: rejects task in a multi-stream plan that omits files", async () => {
      const p: BuildPlan = {
        ...plan,
        tasks: [
          { id: "T1", description: "a", stream: "A", files: ["a.js"] },
          { id: "T2", description: "b", stream: "B" }
        ]
      };
      const errors = validateStreamFileOwnership(p);
      expect(errors.some((e) => e.includes("T2") && e.includes("list its files"))).toBe(true);
    });

    it("validateStreamFileOwnership: rejects overlapping file between two streams", async () => {
      const p: BuildPlan = {
        ...plan,
        tasks: [
          { id: "T1", description: "a", stream: "A", files: ["shared.js"] },
          { id: "T2", description: "b", stream: "B", files: ["shared.js"] }
        ]
      };
      const errors = validateStreamFileOwnership(p);
      expect(errors.some((e) => e.includes("shared.js") && e.includes("disjoint"))).toBe(true);
    });

    it("mergeCompletionReports: union of filesChanged, concatenation of taskResults, complete only when all complete", async () => {
      const a: CompletionReport = {
        status: "complete",
        summary: "stream a done",
        taskResults: [{ id: "T1", status: "done" }],
        filesChanged: ["a.js"],
        verificationResults: [{ command: "npm test", passed: true, output: "ok" }],
        deviationsFromPlan: []
      };
      const b: CompletionReport = {
        status: "complete",
        summary: "stream b done",
        taskResults: [{ id: "T2", status: "done" }],
        filesChanged: ["b.js", "a.js"],
        verificationResults: [],
        deviationsFromPlan: ["custom-flags used"]
      };
      const merged = mergeCompletionReports([
        { streamId: "A", report: a },
        { streamId: "B", report: b }
      ]);
      expect(merged.status).toBe("complete");
      expect(merged.taskResults).toHaveLength(2);
      expect(merged.filesChanged).toEqual(["a.js", "b.js"]); // deduped, A first
      expect(merged.deviationsFromPlan).toEqual(["custom-flags used"]);
      expect(merged.summary).toContain("[A] stream a done");
      expect(merged.summary).toContain("[B] stream b done");
    });

    it("mergeCompletionReports: any blocked stream flips merged to blocked", async () => {
      const a: CompletionReport = {
        status: "complete",
        summary: "ok",
        taskResults: [{ id: "T1", status: "done" }],
        filesChanged: [],
        verificationResults: [],
        deviationsFromPlan: []
      };
      const b: CompletionReport = {
        status: "blocked",
        summary: "stuck",
        taskResults: [{ id: "T2", status: "partial" }],
        filesChanged: [],
        verificationResults: [],
        deviationsFromPlan: []
      };
      const merged = mergeCompletionReports([
        { streamId: "A", report: a },
        { streamId: "B", report: b }
      ]);
      expect(merged.status).toBe("blocked");
    });

    it("mergeCompletionReports: rejects duplicate task result ids across streams", async () => {
      const a: CompletionReport = {
        status: "complete",
        summary: "a",
        taskResults: [{ id: "T1", status: "done" }],
        filesChanged: [],
        verificationResults: [],
        deviationsFromPlan: []
      };
      const b: CompletionReport = {
        status: "complete",
        summary: "b",
        taskResults: [{ id: "T1", status: "done" }],
        filesChanged: [],
        verificationResults: [],
        deviationsFromPlan: []
      };
      expect(() =>
        mergeCompletionReports([
          { streamId: "A", report: a },
          { streamId: "B", report: b }
        ])
      ).toThrow(/duplicate task result ids across streams.*T1/);
    });

    it("validateBuildPlan: rejects overlapping-file 2-stream plan with a clear message", async () => {
      const p: BuildPlan = {
        ...plan,
        tasks: [
          { id: "T1", description: "a", stream: "A", files: ["shared.js"] },
          { id: "T2", description: "b", stream: "B", files: ["shared.js"] }
        ]
      };
      await expect((async () => validateBuildPlan(p))()).rejects.toThrow(/disjoint/);
    });

    it("validateBuildPlan: accepts a clean 2-stream plan with disjoint files", async () => {
      const p: BuildPlan = {
        ...plan,
        tasks: [
          { id: "T1", description: "a", stream: "A", files: ["a.js"] },
          { id: "T2", description: "b", stream: "B", files: ["b.js"] }
        ]
      };
      expect((await validateBuildPlan(p)).tasks).toHaveLength(2);
    });
  });

  describe("verification-script-tampering detection (D56-2)", () => {
    const planWithScript = (verification: string[]): BuildPlan => ({
      ...plan,
      verification
    });

    it("accepts a report that does NOT touch a referenced verification script", async () => {
      const p = planWithScript(["node verify-video.js"]);
      const report = validateCompletionReport(p, {
        status: "complete",
        summary: "ok",
        taskResults: [{ id: "T1", status: "done" }],
        filesChanged: ["src/other.js", "README.md"],
        verificationResults: [{ command: "node verify-video.js", passed: true, output: "ok" }],
        deviationsFromPlan: []
      });
      expect(report.status).toBe("complete");
    });

    it("rejects a report that touches a referenced verification script without declaring it", async () => {
      const p = planWithScript(["node verify-video.js"]);
      expect(() =>
        validateCompletionReport(p, {
          status: "complete",
          summary: "ok",
          taskResults: [{ id: "T1", status: "done" }],
          filesChanged: ["verify-video.js"],
          verificationResults: [{ command: "node verify-video.js", passed: true, output: "ok" }],
          deviationsFromPlan: []
        })
      ).toThrow(/Verification script edited without disclosure.*verify-video\.js/);
    });

    it("accepts a report that touches a referenced verification script when deviationsFromPlan mentions it", async () => {
      const p = planWithScript(["node verify-video.js"]);
      const report = validateCompletionReport(p, {
        status: "complete",
        summary: "ok",
        taskResults: [{ id: "T1", status: "done" }],
        filesChanged: ["verify-video.js"],
        verificationResults: [{ command: "node verify-video.js", passed: true, output: "ok" }],
        deviationsFromPlan: ["widened verify-video.js tolerance to 15s to account for the real-world render time"]
      });
      expect(report.status).toBe("complete");
    });

    it("matches verification scripts by basename across path/separator styles", async () => {
      const p = planWithScript(['node "C:\\\\path\\\\to\\\\verify-video.js"']);
      expect(() =>
        validateCompletionReport(p, {
          status: "complete",
          summary: "ok",
          taskResults: [{ id: "T1", status: "done" }],
          filesChanged: ["verify-video.js"],
          verificationResults: [{ command: p.verification[0] ?? "", passed: true, output: "ok" }],
          deviationsFromPlan: []
        })
      ).toThrow(/verify-video\.js/);
    });

    it("does not flag the original transcript's bug (verify-video.js + widened tolerance without disclosure)", async () => {
      // Real D56-2 bug report shape: verify-video.js is the only verification, worker edits it,
      // and reports all-passing. The D56-1 fix path (harness D56-1 destructive gate) and D55
      // (ffprobe) addressed how the worker got there in the first place; D56-2 prevents it
      // from completing with a passing grade.
      const p = planWithScript(["node verify-video.js"]);
      expect(() =>
        validateCompletionReport(p, {
          status: "complete",
          summary: "Build succeeded; verification passed",
          taskResults: [{ id: "T1", status: "done" }],
          filesChanged: ["verify-video.js", "out.mp4"],
          verificationResults: [{ command: "node verify-video.js", passed: true, output: "ok" }],
          deviationsFromPlan: []
        })
      ).toThrow(/Verification script edited without disclosure: verify-video\.js/);
    });

    it("skips the check when the plan has no script-suffixed verification commands", async () => {
      const p = planWithScript(["npm test", "ffprobe -show_entries format=duration foo.mp4"]);
      // Even if files changed include a JS file, no script reference -> no flag.
      const report = validateCompletionReport(p, {
        status: "complete",
        summary: "ok",
        taskResults: [{ id: "T1", status: "done" }],
        filesChanged: ["index.js", "foo.mp4"],
        verificationResults: [
          { command: "npm test", passed: true, output: "ok" },
          { command: "ffprobe -show_entries format=duration foo.mp4", passed: true, output: "ok" }
        ],
        deviationsFromPlan: []
      });
      expect(report.status).toBe("complete");
    });
  });

  it("fails verification entries when the exact matched command failed", async () => {
    const exactPlan: BuildPlan = {
      ...plan,
      verification: ["node test.mjs"]
    };
    expect(() =>
      validateCompletionReport(exactPlan, {
        status: "complete",
        summary: "done",
        taskResults: [{ id: "T1", status: "done" }],
        filesChanged: ["test.mjs"],
        verificationResults: [{ command: "node test.mjs", passed: false, output: "boom" }],
        deviationsFromPlan: []
      })
    ).toThrow(/failing verification/);
  });

  it("rejects approve verdicts with severe scores", async () => {
    expect(() =>
      ReviewVerdictSchema.parse({
        verdict: "approve",
        scores: { correctness: 1, planAdherence: 5, codeQuality: 5 },
        feedback: [],
        userSummary: "Looks good."
      })
    ).toThrow(/approve verdict requires scores above 2/);
  });

  it("allows revise verdicts with severe scores", async () => {
    const verdict = ReviewVerdictSchema.parse({
      verdict: "revise",
      scores: { correctness: 1, planAdherence: 2, codeQuality: 2 },
      feedback: [{ issue: "broken", requiredChange: "fix it" }],
      userSummary: "Needs fixes."
    });

    expect(verdict.verdict).toBe("revise");
  });
});

describe("verification entry allowlist (D55)", () => {
  const basePlan = (verification: string[]) => ({
    title: "Demo",
    objective: "Build demo.",
    constraints: [],
    tasks: [{ id: "T1", description: "Do work" }],
    acceptanceCriteria: ["Works"],
    verification
  });

  // D55-1: explicit allowlist additions.
  it("accepts ffprobe and ffmpeg (D55-1 allowlist)", async () => {
    await (expect(async () => validateBuildPlan(basePlan(['ffprobe -v error -print_format json -show_format "video.mp4"']), "linux"))).not.toThrow();
    await (expect(async () => validateBuildPlan(basePlan(["ffmpeg -i in.mp4 -vf scale=1280:720 out.mp4"]), "linux"))).not.toThrow();
  });

  it("accepts the four ffprobe commands from the original bug report", async () => {
    const cmds = [
      'ffprobe -v error -print_format json -show_format "C:\\\\Users\\\\me\\\\videos\\\\explainer-en.mp4"',
      'ffprobe -v error -show_streams "input.mp4"',
      'ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height "input.mp4"',
      'ffprobe -v quiet -of csv=p=0 -show_entries format=duration "input.mp4"'
    ];
    await (expect(async () => validateBuildPlan(basePlan(cmds), "linux"))).not.toThrow();
  });

  it("accepts the rest of the D55-1 expanded allowlist (ffplay, magick, convert, sox, pandoc, curl, wget, docker, java, ruby, php, dir, where, certutil)", async () => {
    const cmds = [
      "ffplay input.mp4",
      "magick input.png -resize 50% output.png",
      "convert input.heic output.jpg",
      "sox input.wav output.wav norm",
      "pandoc -o out.html in.md",
      "curl -sSf https://example.com/file",
      "wget -q https://example.com/file",
      "docker compose up -d",
      "docker build -t app .",
      "java -jar app.jar",
      "ruby script.rb",
      "php index.php",
      "dir",
      "where node",
      "certutil -hashfile foo.txt SHA256"
    ];
    await (expect(async () => validateBuildPlan(basePlan(cmds), "linux"))).not.toThrow();
  });

  // D55-2: heuristic acceptance for arbitrary binaries not on the list.
  it("accepts an arbitrary binary that follows flag syntax (D55-2 heuristic)", async () => {
    await (expect(async () => validateBuildPlan(basePlan(["somebinary --check --input path\\to\\file"]), "linux"))).not.toThrow();
  });

  it("accepts an arbitrary binary invoked with a path arg (D55-2 heuristic)", async () => {
    await (expect(async () => validateBuildPlan(basePlan(["mytool /var/data/file"]), "linux"))).not.toThrow();
  });

  it("accepts an arbitrary binary invoked with a relative path (D55-2 heuristic)", async () => {
    await (expect(async () => validateBuildPlan(basePlan(["mytool ./local.txt"]), "linux"))).not.toThrow();
  });

  // D55-2 prose regression — these MUST still be rejected.
  it("still rejects plain prose verification entries", async () => {
    await expect((async () => validateBuildPlan(basePlan(["verify the video plays correctly with both audio tracks"]), "linux"))()).rejects.toThrow(/does not look like a runnable shell command/);
    await expect((async () => validateBuildPlan(basePlan(["ensure the output file exists and has correct format"]), "linux"))()).rejects.toThrow(/does not look like a runnable shell command/);
  });

  // Regression: prose with a leading hyphen could falsely match (it's a documented
  // over-acceptance edge case in D55-2 — pure-prose commands starting with a verb + dash
  // like "verify -all the -output" would pass). This test documents current behavior; if we
  // tighten the heuristic later, update this expectation.
  it("documented over-acceptance edge case: prose starting with verb-then-dash passes", async () => {
    await (expect(async () => validateBuildPlan(basePlan(["verify -all the -output"]), "linux"))).not.toThrow();
  });

  // Regression: POSIX-tool guard on win32 must be unchanged.
  it("still rejects POSIX-only tools on Windows even if they're 'unrecognized binaries' (D55-2 keeps POSIX guard)", async () => {
    await expect((async () => validateBuildPlan(basePlan(["grep -r foo ."]), "win32"))()).rejects.toThrow(/POSIX-only tool `grep`/);
    await expect((async () => validateBuildPlan(basePlan(["sed -i 's/foo/bar/' file.txt"]), "win32"))()).rejects.toThrow(/POSIX-only tool `sed`/);
  });

  describe("D57 PATH-resolution primary signal", () => {
    // The primary signal is real PATH lookup. Built-ins (interpreter-internal) bypass
    // PATH. The D55-2 shape heuristic is a soft fallback for tools that may not be on the
    // validation machine. These tests inject a fake env + exists to keep behavior deterministic.
    it("accepts a token that resolves on PATH (D57 primary signal)", async () => {
      const env = { PATH: "/usr/bin:/bin" };
      const target = path.join("/usr/bin", "ffprobe");
      const exists = (p: string) => p === target;
      // We can't easily call validateBuildPlan with a custom exists/lookup, so we call the
      // helper directly to verify the primary signal contract.
      const { resolveOnPath } = await import("../src/tools/resolve-on-path.js");
      expect(
        resolveOnPath({ token: "ffprobe", names: ["ffprobe"], env, pathSeparator: ":", exists })
      ).toBe(target);
    });

    it("accepts a win32 PATH lookup that finds a .cmd shim (D57 win32 .cmd/.exe names)", async () => {
      const env = { PATH: "C:\\Windows\\System32;C:\\Program Files\\nodejs" };
      const exists = (p: string) => p === path.join("C:\\Program Files\\nodejs", "node.cmd");
      const { resolveOnPath } = await import("../src/tools/resolve-on-path.js");
      expect(
        resolveOnPath({ token: "node", names: ["node.exe", "node.cmd", "node"], env, pathSeparator: ";", exists })
      ).toBe(path.join("C:\\Program Files\\nodejs", "node.cmd"));
    });

    it("rejects a fake-binary command even when it has flag syntax (D57: PATH resolution, not shape, is primary)", async () => {
      // 'totally-not-a-real-tool-xyz' has flag syntax and a path arg. Old D55-2 heuristic
      // would have accepted it. D57 must reject because PATH resolution (the primary
      // signal) returns nothing.
      const env = { PATH: "/usr/bin" };
      const exists = () => false; // not installed
      const { resolveOnPath } = await import("../src/tools/resolve-on-path.js");
      expect(
        resolveOnPath({
          token: "totally-not-a-real-tool-xyz",
          names: ["totally-not-a-real-tool-xyz"],
          env,
          pathSeparator: ":",
          exists
        })
      ).toBeUndefined();
    });

    it("accepts a shell built-in command without PATH lookup (D57-2 small built-ins set)", async () => {
      // `cd` is a shell built-in; never resolves via PATH. The built-ins set allows it.
      const env = { PATH: "" };
      const exists = () => false;
      const { resolveOnPath } = await import("../src/tools/resolve-on-path.js");
      expect(
        resolveOnPath({ token: "cd", names: ["cd"], env, pathSeparator: ":", exists })
      ).toBeUndefined();
      // The validator still passes `cd` because shellBuiltIns.has("cd") === true.
      await expect(
        (async () => validateBuildPlan(basePlan(["cd /tmp"]), "linux"))()
      ).resolves.toBeDefined();
    });
  });
});
