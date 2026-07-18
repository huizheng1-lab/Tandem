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
    await execa("git", ["add", "README.md"], { cwd: repo });
    await execa("git", ["add", ".gitignore"], { cwd: repo });
    await execa("git", ["add", "scripts/reciprocal-direction.ps1"], { cwd: repo });
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

  const approveVerdict = JSON.stringify({
    verdict: "approve",
    scores: { correctness: 5, planAdherence: 5, codeQuality: 5 },
    feedback: [],
    userSummary: "Candidate is approved."
  });

  async function createCandidate(repo: string) {
    await relay(repo, "-Action", "Reset", "-Force");
    await relay(repo, "-Action", "Claim", "-Role", "A");
    await writeFile(path.join(repo, "README.md"), "initial\ncandidate\n", "utf8");
    await execa("git", ["add", "README.md"], { cwd: repo });
    await execa("git", ["commit", "-m", "candidate"], { cwd: repo });
    const completed = await relay(repo, "-Action", "Complete", "-Role", "A", "-Summary", "candidate ready");
    const candidateCommit = completed.candidateCommit as string;
    await execa("git", ["switch", "codex/reciprocal-a"], { cwd: repo });
    await execa("git", ["merge", "--ff-only", candidateCommit], { cwd: repo });
    return candidateCommit;
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

  windowsIt("D132: pause closes a clean no-work active turn", async () => {
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

  windowsIt("D133: repeated RESUME claims auto-pause and reset after recovery actions", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d133-resume-"));
    try {
      await initRepo(repo);
      await relay(repo, "-Action", "Reset", "-Force");
      await relay(repo, "-Action", "Claim", "-Role", "A");

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
      expect(thirdResume.lastSummary).toContain("Auto-paused turn");

      await relay(repo, "-Action", "Resume", "-Summary", "human inspected the stalled turn");
      const afterResume = await relay(repo, "-Action", "Claim", "-Role", "A");
      expect(afterResume).toMatchObject({ outcome: "RESUME", resumeCount: 1 });

      const abandoned = await relay(repo, "-Action", "Abandon", "-Role", "A", "-Summary", "reset stalled no-work turn");
      expect(abandoned).toMatchObject({ outcome: "ABANDONED", resumeCount: 0, activeRole: null });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D132: accept completes a matching non-epic direction candidate", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d132-accept-"));
    try {
      await initRepo(repo);
      await mkdir(path.join(repo, ".tandem", "shared-control"), { recursive: true });

      await relay(repo, "-Action", "Reset", "-Force");
      await relay(repo, "-Action", "Claim", "-Role", "A");
      await writeFile(path.join(repo, "README.md"), "initial\ncandidate\n", "utf8");
      await execa("git", ["add", "README.md"], { cwd: repo });
      await execa("git", ["commit", "-m", "candidate"], { cwd: repo });
      const completed = await relay(repo, "-Action", "Complete", "-Role", "A", "-Summary", "candidate ready");
      const candidateCommit = completed.candidateCommit;
      expect(candidateCommit).toMatch(/^[0-9a-f]{40}$/);

      await execa("git", ["switch", "codex/reciprocal-a"], { cwd: repo });
      await execa("git", ["merge", "--ff-only", candidateCommit], { cwd: repo });

      const boardPath = path.join(repo, ".tandem", "shared-control", "SHARED_DIRECTION.md");
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
          `- [ ] W0001 | P3 | D132 scratch candidate | CANDIDATE commit=${candidateCommit} updated=2026-07-17T00:00:00Z`,
          "",
        ].join("\n"),
        "utf8",
      );

      await relay(repo, "-Action", "Claim", "-Role", "B");
      const accepted = await relay(repo, "-Action", "Accept", "-Role", "B", "-Summary", "candidate baseline verified");
      expect(accepted).toMatchObject({ outcome: "ACCEPTED", stableCommit: candidateCommit });

      const board = await readFile(boardPath, "utf8");
      expect(board).toContain(`- [x] W0001 | P3 | D132 scratch candidate | DONE stable=${candidateCommit}`);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D133: accept auto-approves epic plan after stable ref advances", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d133-auto-approve-"));
    try {
      await initRepo(repo);
      await mkdir(path.join(repo, ".tandem", "shared-control"), { recursive: true });

      await relay(repo, "-Action", "Reset", "-Force");
      await relay(repo, "-Action", "Claim", "-Role", "A");
      await mkdir(path.join(repo, "process", "reciprocal", "epics"), { recursive: true });
      await writeFile(path.join(repo, "process", "reciprocal", "epics", "W0002-plan.md"), "# Plan\n", "utf8");
      await execa("git", ["add", "process/reciprocal/epics/W0002-plan.md"], { cwd: repo });
      await execa("git", ["commit", "-m", "candidate"], { cwd: repo });
      const completed = await relay(repo, "-Action", "Complete", "-Role", "A", "-Summary", "candidate ready");
      const candidateCommit = completed.candidateCommit;

      await execa("git", ["switch", "codex/reciprocal-a"], { cwd: repo });
      await execa("git", ["merge", "--ff-only", candidateCommit], { cwd: repo });

      const boardPath = path.join(repo, ".tandem", "shared-control", "SHARED_DIRECTION.md");
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
          `- [ ] W0002 | P2 | D133 plan candidate | CANDIDATE epic=true autonomy=full candidate=PLAN revision=1 completed=0 steps=2 plan=process/reciprocal/epics/W0002-plan.md commit=${candidateCommit} updated=2026-07-17T00:00:00Z`,
          "",
        ].join("\n"),
        "utf8",
      );

      await relay(repo, "-Action", "Claim", "-Role", "B");
      const accepted = await relay(repo, "-Action", "Accept", "-Role", "B", "-Summary", "plan verified");
      expect(accepted).toMatchObject({ outcome: "ACCEPTED", stableCommit: candidateCommit });

      const board = await readFile(boardPath, "utf8");
      expect(board).toContain(`PLAN_APPROVED epic=true autonomy=full revision=1 completed=0 steps=2 next=1/2 plan=process/reciprocal/epics/W0002-plan.md commit=${candidateCommit}`);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D143: validate dry-run reviews a paused candidate without advancing relay state", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d143-dryrun-"));
    try {
      await initRepo(repo);
      const candidateCommit = await createCandidate(repo);
      await relay(repo, "-Action", "Pause", "-Summary", "human paused before validation redesign");

      const result = await relay(
        repo,
        "-Action",
        "Validate",
        "-Role",
        "B",
        "-DryRun",
        "-ValidationChecks",
        "git diff --check refs/tandem-relay/stable refs/tandem-relay/candidate --",
        "-ReviewVerdictJson",
        approveVerdict,
      );

      expect(result).toMatchObject({
        outcome: "VALIDATION_APPROVE_DRY_RUN",
        phase: "paused",
        activeRole: null,
        candidateCommit,
        reviewVerdict: "approve",
      });
      expect(result.stableCommit).not.toBe(candidateCommit);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D143: validate accepts an approved candidate after mechanical checks", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d143-approve-"));
    try {
      await initRepo(repo);
      const candidateCommit = await createCandidate(repo);
      await relay(repo, "-Action", "Claim", "-Role", "B");

      const result = await relay(
        repo,
        "-Action",
        "Validate",
        "-Role",
        "B",
        "-ValidationChecks",
        "git diff --check refs/tandem-relay/stable refs/tandem-relay/candidate --",
        "-ReviewVerdictJson",
        approveVerdict,
      );

      expect(result).toMatchObject({
        outcome: "ACCEPTED",
        phase: "working",
        stableCommit: candidateCommit,
        candidateCommit: null,
        reviewVerdict: "approve",
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);

  windowsIt("D143: validate rejects and rolls back when a mechanical check fails", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "tandem-relay-d143-reject-"));
    try {
      await initRepo(repo);
      const candidateCommit = await createCandidate(repo);
      await relay(repo, "-Action", "Claim", "-Role", "B");

      const result = await relay(
        repo,
        "-Action",
        "Validate",
        "-Role",
        "B",
        "-ValidationChecks",
        "git rev-parse --verify refs/heads/definitely-missing-d143",
      );

      expect(result).toMatchObject({
        outcome: "ROLLBACK_CREATED",
        phase: "rollback-verification",
        candidateCommit,
        validationOutcome: "mechanical-failed",
      });
      expect(result.rollbackCommit).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  }, 30_000);
});
