import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const windowsIt = process.platform === "win32" ? it : it.skip;

describe("reciprocal relay script", () => {
  async function initRepo(repo: string) {
    await execa("git", ["init"], { cwd: repo });
    await execa("git", ["config", "user.email", "relay@example.test"], { cwd: repo });
    await execa("git", ["config", "user.name", "Relay Test"], { cwd: repo });
    await mkdir(path.join(repo, "scripts"), { recursive: true });
    await writeFile(path.join(repo, "README.md"), "initial\n", "utf8");
    await writeFile(path.join(repo, ".gitignore"), ".tandem/\n", "utf8");
    await writeFile(
      path.join(repo, "scripts", "reciprocal-direction.ps1"),
      await readFile(path.resolve("scripts/reciprocal-direction.ps1"), "utf8"),
      "utf8",
    );
    await writeFile(
      path.join(repo, "scripts", "promote-reciprocal-runtime.ps1"),
      await readFile(path.resolve("scripts/promote-reciprocal-runtime.ps1"), "utf8"),
      "utf8",
    );
    await execa("git", ["add", "README.md", ".gitignore", "scripts/reciprocal-direction.ps1", "scripts/promote-reciprocal-runtime.ps1"], { cwd: repo });
    await execa("git", ["commit", "-m", "initial"], { cwd: repo });
    await execa("git", ["branch", "codex/reciprocal-a"], { cwd: repo });
    await execa("git", ["branch", "codex/reciprocal-b"], { cwd: repo });
    await execa("git", ["switch", "codex/reciprocal-b"], { cwd: repo });
  }

  async function relay(repo: string, ...args: string[]) {
    const script = path.resolve("scripts/reciprocal-relay.ps1");
    const result = await execa("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args], { cwd: repo });
    return JSON.parse(result.stdout);
  }

  async function writeSharedBoard(repo: string, line: string) {
    const boardDir = path.join(repo, ".tandem", "shared-control");
    await mkdir(boardDir, { recursive: true });
    const boardPath = path.join(boardDir, "SHARED_DIRECTION.md");
    await writeFile(
      boardPath,
      [
        "# Tandem Reciprocal: Shared Direction",
        "",
        "AutonomyDefault: plan-gated",
        "",
        "## Wishlist And Progress",
        "",
        "<!-- wishlist-items -->",
        line,
        "",
      ].join("\n"),
      "utf8",
    );
    return boardPath;
  }

  async function createCandidate(repo: string, fileText = "initial\ncandidate\n") {
    await relay(repo, "-Action", "Reset", "-Force");
    const claimed = await relay(repo, "-Action", "Claim", "-Role", "A");
    expect(claimed).toMatchObject({ outcome: "CLAIMED", phase: "working", activeRole: "A" });
    await writeFile(path.join(repo, "README.md"), fileText, "utf8");
    await execa("git", ["add", "README.md"], { cwd: repo });
    await execa("git", ["commit", "-m", "candidate"], { cwd: repo });
    const completed = await relay(repo, "-Action", "Complete", "-Role", "A", "-Summary", "candidate ready");
    expect(completed).toMatchObject({ outcome: "COMPLETED", phase: "passive-testing", nextRole: "A", activeRole: null });
    return completed.candidateCommit as string;
  }

  windowsIt("D129: status does not lock packed refs when relay refs are unchanged", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d129-"));
    const script = path.resolve("scripts/reciprocal-relay.ps1");
    try {
      await execa("git", ["init"], { cwd: repo });
      await execa("git", ["config", "user.email", "d129@example.test"], { cwd: repo });
      await execa("git", ["config", "user.name", "D129 Test"], { cwd: repo });
      await writeFile(path.join(repo, "README.md"), "D129\n", "utf8");
      await execa("git", ["add", "README.md"], { cwd: repo });
      await execa("git", ["commit", "-m", "initial"], { cwd: repo });
      await execa("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", "Reset", "-Force"], { cwd: repo });
      await execa("git", ["pack-refs", "--all", "--prune"], { cwd: repo });

      await mkdir(path.join(repo, ".git", "packed-refs.lock"));
      const result = await execa("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", "Status"], { cwd: repo });

      expect(JSON.parse(result.stdout)).toMatchObject({ outcome: "STATUS" });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  windowsIt("D132: pause closes a clean no-work active A turn", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d132-pause-"));
    try {
      await initRepo(repo);
      await relay(repo, "-Action", "Reset", "-Force");
      await relay(repo, "-Action", "Claim", "-Role", "A");

      const paused = await relay(repo, "-Action", "Pause", "-Role", "A", "-Summary", "no queued human item");
      expect(paused).toMatchObject({
        outcome: "PAUSED",
        activeRole: null,
        phase: "paused",
        pauseAfterTurn: false,
        baseCommit: null,
        nextRole: "A",
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  windowsIt("D133: repeated RESUME claims still auto-pause A recovery loops", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d133-resume-"));
    try {
      await initRepo(repo);
      await relay(repo, "-Action", "Reset", "-Force");
      await relay(repo, "-Action", "Claim", "-Role", "A");
      await mkdir(path.join(repo, ".tandem"), { recursive: true });
      await writeFile(path.join(repo, ".tandem", "reciprocal-checkpoint.md"), "resume checkpoint\n", "utf8");

      const firstResume = await relay(repo, "-Action", "Claim", "-Role", "A");
      const secondResume = await relay(repo, "-Action", "Claim", "-Role", "A");
      const thirdResume = await relay(repo, "-Action", "Claim", "-Role", "A");

      expect(firstResume).toMatchObject({ outcome: "RESUME", resumeCount: 1, resumeThreshold: 3 });
      expect(secondResume).toMatchObject({ outcome: "RESUME", resumeCount: 2, resumeThreshold: 3 });
      expect(thirdResume).toMatchObject({
        outcome: "PAUSED",
        phase: "paused",
        pausedFromPhase: "working",
        activeRole: "A",
        resumeCount: 3,
        resumeThreshold: 3,
      });

      await relay(repo, "-Action", "Resume", "-Summary", "human inspected the stalled turn");
      const afterResume = await relay(repo, "-Action", "Claim", "-Role", "A");
      expect(afterResume).toMatchObject({ outcome: "RESUME", resumeCount: 1 });

      const abandoned = await relay(repo, "-Action", "Abandon", "-Role", "A", "-Summary", "reset stalled no-work turn");
      expect(abandoned).toMatchObject({ outcome: "ABANDONED", resumeCount: 0, activeRole: null });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D151: B never receives an agentic claim and A routes candidates to passive testing", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d151-claim-"));
    try {
      await initRepo(repo);
      const passiveB = await relay(repo, "-Action", "Claim", "-Role", "B");
      expect(passiveB).toMatchObject({ outcome: "WAIT", passiveOnly: true });

      const candidateCommit = await createCandidate(repo);
      const aClaim = await relay(repo, "-Action", "Claim", "-Role", "A");
      expect(aClaim).toMatchObject({ outcome: "PASSIVE_TEST", phase: "passive-testing", candidateCommit });

      await execa("git", ["switch", "codex/reciprocal-a"], { cwd: repo });
      const bClaim = await relay(repo, "-Action", "Claim", "-Role", "B");
      expect(bClaim).toMatchObject({ outcome: "WAIT", passiveOnly: true, candidateCommit });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D151: passive test accepts a candidate and stops at the A-upgrade human gate", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d151-passive-"));
    try {
      await initRepo(repo);
      const candidateCommit = await createCandidate(repo);
      await execa("git", ["switch", "codex/reciprocal-a"], { cwd: repo });
      const boardPath = await writeSharedBoard(
        repo,
        `- [ ] W0001 | P3 | passive candidate | CANDIDATE commit=${candidateCommit} updated=2026-07-18T00:00:00Z`,
      );

      const accepted = await relay(
        repo,
        "-Action",
        "PassiveTest",
        "-Role",
        "A",
        "-Summary",
        "passive checks green",
        "-ValidationChecks",
        "git diff --check refs/tandem-relay/stable refs/tandem-relay/candidate --",
      );
      expect(accepted).toMatchObject({
        outcome: "PASSIVE_ACCEPTED",
        phase: "a-upgrade-pending",
        stableCommit: candidateCommit,
        candidateCommit: null,
        nextRole: "A",
        activeRole: null,
      });

      const board = await readFile(boardPath, "utf8");
      expect(board).toContain(`- [x] W0001 | P3 | passive candidate | DONE stable=${candidateCommit}`);

      const waitingClaim = await relay(repo, "-Action", "Claim", "-Role", "A");
      expect(waitingClaim).toMatchObject({ outcome: "A_UPGRADE_PENDING" });

      const ready = await relay(repo, "-Action", "PrepareAUpgrade", "-Role", "A", "-DryRun");
      expect(ready).toMatchObject({ outcome: "A_UPGRADE_READY", sourceSha: candidateCommit });
      expect(ready.promotionCommand).toContain("-TargetRole A");

      const completed = await relay(repo, "-Action", "CompleteAUpgrade", "-Role", "A", "-Force", "-Summary", "human confirmed A rebuild");
      expect(completed).toMatchObject({ outcome: "A_UPGRADE_COMPLETED", phase: "idle", nextRole: "A" });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D151: passive check failure pauses without handing work to B", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d151-fail-"));
    try {
      await initRepo(repo);
      const candidateCommit = await createCandidate(repo);
      await execa("git", ["switch", "codex/reciprocal-a"], { cwd: repo });

      const result = await relay(
        repo,
        "-Action",
        "PassiveTest",
        "-Role",
        "A",
        "-ValidationChecks",
        "git rev-parse --verify refs/heads/definitely-missing-d151",
      );
      expect(result).toMatchObject({
        outcome: "PASSIVE_FAILED",
        phase: "paused",
        pausedFromPhase: "passive-testing",
        activeRole: null,
        candidateCommit,
      });

      const bClaim = await relay(repo, "-Action", "Claim", "-Role", "B");
      expect(bClaim).toMatchObject({ outcome: "WAIT", passiveOnly: true });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);
});
