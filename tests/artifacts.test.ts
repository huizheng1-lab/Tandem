import { describe, expect, it } from "vitest";
import { BuildPlan, ReviewVerdictSchema, validateBuildPlan, validateCompletionReport } from "../src/orchestrator/artifacts.js";

const plan: BuildPlan = {
  title: "Demo",
  objective: "Build demo.",
  constraints: [],
  tasks: [{ id: "T1", description: "Do work" }],
  acceptanceCriteria: ["Works"],
  verification: ["npm test"]
};

describe("artifacts", () => {
  it("rejects reports that omit plan verification commands", () => {
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

  it("rejects prose verification entries in build plans", () => {
    expect(() =>
      validateBuildPlan(
        {
          ...plan,
          verification: ["Play game and verify all effects are working"]
        },
        "win32"
      )
    ).toThrow(/does not look like a runnable shell command/);
  });

  it("rejects zero-task build plans as direct-answer work", () => {
    expect(() => validateBuildPlan({ ...plan, tasks: [] })).toThrow(/no implementation tasks - answer directly instead/);
  });

  it("rejects POSIX verification commands on Windows with safer alternatives", () => {
    expect(() => validateBuildPlan({ ...plan, verification: ["cat launch.bat"] }, "win32")).toThrow(/POSIX-only tool `cat`.*type <file>/s);
    expect(() => validateBuildPlan({ ...plan, verification: ["cat index.html | grep -E 'src=|title='"] }, "win32")).toThrow(/POSIX-only tool `cat`.*POSIX-only tool `grep`.*findstr/s);
  });

  it("accepts Windows-safe and cross-platform verification commands", () => {
    expect(validateBuildPlan({ ...plan, verification: ["npm test", "node test.mjs", "type launch.bat"] }, "win32").verification).toHaveLength(3);
  });

  it("requires completion reports to echo plan verification commands exactly", () => {
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

  describe("verification-script-tampering detection (D56-2)", () => {
    const planWithScript = (verification: string[]): BuildPlan => ({
      ...plan,
      verification
    });

    it("accepts a report that does NOT touch a referenced verification script", () => {
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

    it("rejects a report that touches a referenced verification script without declaring it", () => {
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

    it("accepts a report that touches a referenced verification script when deviationsFromPlan mentions it", () => {
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

    it("matches verification scripts by basename across path/separator styles", () => {
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

    it("does not flag the original transcript's bug (verify-video.js + widened tolerance without disclosure)", () => {
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

    it("skips the check when the plan has no script-suffixed verification commands", () => {
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

  it("fails verification entries when the exact matched command failed", () => {
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

  it("rejects approve verdicts with severe scores", () => {
    expect(() =>
      ReviewVerdictSchema.parse({
        verdict: "approve",
        scores: { correctness: 1, planAdherence: 5, codeQuality: 5 },
        feedback: [],
        userSummary: "Looks good."
      })
    ).toThrow(/approve verdict requires scores above 2/);
  });

  it("allows revise verdicts with severe scores", () => {
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
  it("accepts ffprobe and ffmpeg (D55-1 allowlist)", () => {
    expect(() => validateBuildPlan(basePlan(['ffprobe -v error -print_format json -show_format "video.mp4"']), "linux")).not.toThrow();
    expect(() => validateBuildPlan(basePlan(["ffmpeg -i in.mp4 -vf scale=1280:720 out.mp4"]), "linux")).not.toThrow();
  });

  it("accepts the four ffprobe commands from the original bug report", () => {
    const cmds = [
      'ffprobe -v error -print_format json -show_format "C:\\\\Users\\\\me\\\\videos\\\\explainer-en.mp4"',
      'ffprobe -v error -show_streams "input.mp4"',
      'ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height "input.mp4"',
      'ffprobe -v quiet -of csv=p=0 -show_entries format=duration "input.mp4"'
    ];
    expect(() => validateBuildPlan(basePlan(cmds), "linux")).not.toThrow();
  });

  it("accepts the rest of the D55-1 expanded allowlist (ffplay, magick, convert, sox, pandoc, curl, wget, docker, java, ruby, php, dir, where, certutil)", () => {
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
    expect(() => validateBuildPlan(basePlan(cmds), "linux")).not.toThrow();
  });

  // D55-2: heuristic acceptance for arbitrary binaries not on the list.
  it("accepts an arbitrary binary that follows flag syntax (D55-2 heuristic)", () => {
    expect(() => validateBuildPlan(basePlan(["somebinary --check --input path\\to\\file"]), "linux")).not.toThrow();
  });

  it("accepts an arbitrary binary invoked with a path arg (D55-2 heuristic)", () => {
    expect(() => validateBuildPlan(basePlan(["mytool /var/data/file"]), "linux")).not.toThrow();
  });

  it("accepts an arbitrary binary invoked with a relative path (D55-2 heuristic)", () => {
    expect(() => validateBuildPlan(basePlan(["mytool ./local.txt"]), "linux")).not.toThrow();
  });

  // D55-2 prose regression — these MUST still be rejected.
  it("still rejects plain prose verification entries", () => {
    expect(() => validateBuildPlan(basePlan(["verify the video plays correctly with both audio tracks"]), "linux")).toThrow(/does not look like a runnable shell command/);
    expect(() => validateBuildPlan(basePlan(["ensure the output file exists and has correct format"]), "linux")).toThrow(/does not look like a runnable shell command/);
  });

  // Regression: prose with a leading hyphen could falsely match (it's a documented
  // over-acceptance edge case in D55-2 — pure-prose commands starting with a verb + dash
  // like "verify -all the -output" would pass). This test documents current behavior; if we
  // tighten the heuristic later, update this expectation.
  it("documented over-acceptance edge case: prose starting with verb-then-dash passes", () => {
    expect(() => validateBuildPlan(basePlan(["verify -all the -output"]), "linux")).not.toThrow();
  });

  // Regression: POSIX-tool guard on win32 must be unchanged.
  it("still rejects POSIX-only tools on Windows even if they're 'unrecognized binaries' (D55-2 keeps POSIX guard)", () => {
    expect(() => validateBuildPlan(basePlan(["grep -r foo ."]), "win32")).toThrow(/POSIX-only tool `grep`/);
    expect(() => validateBuildPlan(basePlan(["sed -i 's/foo/bar/' file.txt"]), "win32")).toThrow(/POSIX-only tool `sed`/);
  });
});
