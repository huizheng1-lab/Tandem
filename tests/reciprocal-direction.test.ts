import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it, vi } from "vitest";

const describeWindows = process.platform === "win32" ? describe : describe.skip;
const scriptPath = path.resolve("scripts", "reciprocal-direction.ps1");
const PROCESS_SPAWNING_TEST_TIMEOUT_MS = 30_000;

vi.setConfig({ testTimeout: PROCESS_SPAWNING_TEST_TIMEOUT_MS });

async function boardFile(): Promise<string> {
  const dir = path.join(tmpdir(), `tandem-direction-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "SHARED_DIRECTION.md");
  await writeFile(file, [
    "# Shared Direction",
    "",
    "## General Direction",
    "",
    "Test safely.",
    "",
    "## Human Guardrails",
    "",
    "- Preserve history.",
    "",
    "## Wishlist And Progress",
    "",
    "<!-- wishlist-items -->",
    "",
    "## Human Notes",
    "",
    "None.",
    "",
  ].join("\n"), "utf8");
  return file;
}

async function direction(file: string, ...args: string[]) {
  return execa("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
    ...args, "-ControlPath", file,
  ]);
}

async function directionWithEnv(file: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return execa("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
    ...args, "-ControlPath", file,
  ], { env });
}

function wishlistFile(file: string): string {
  return path.join(path.dirname(file), "WISHLIST.md");
}

async function readBoard(file: string): Promise<string> {
  return readFile(wishlistFile(file), "utf8");
}

function boardText(itemLine = ""): string {
  return [
    "# Shared Direction",
    "",
    "## General Direction",
    "",
    "Test safely.",
    "",
    "## Human Guardrails",
    "",
    "- Preserve history.",
    "",
    "## Wishlist And Progress",
    "",
    "<!-- wishlist-items -->",
    itemLine,
    "",
    "## Human Notes",
    "",
    "None.",
    "",
  ].join("\n");
}

async function acceptedCommit(): Promise<string> {
  try { return (await execa("git", ["rev-parse", "refs/tandem-relay/stable"])).stdout.trim(); }
  catch { return (await execa("git", ["rev-parse", "HEAD"])).stdout.trim(); }
}

describeWindows("reciprocal direction wishlist removal", () => {
  it("D167: keeps live wishlist items out of the human shared direction file", async () => {
    const file = await boardFile();
    const added = JSON.parse((await direction(file, "-Action", "Add", "-Priority", "P0", "-Text", "Infrastructure repair")).stdout);

    const shared = await readFile(file, "utf8");
    const board = await readBoard(file);
    expect(shared).not.toContain(added.id);
    expect(shared).not.toContain("<!-- wishlist-items -->");
    expect(board).toContain(`${added.id} | P0 | Infrastructure repair | QUEUED`);
  });

  it("D168: migrates legacy wishlist text as UTF-8 without mojibake", async () => {
    const text = "Preserve leader\u2019s \u201cHi\u201d answer";
    const file = await boardFile();
    await writeFile(file, boardText(`- [ ] W9999 | P0 | ${text} | QUEUED added=now`), "utf8");

    await direction(file, "-Action", "Show");

    const shared = await readFile(file, "utf8");
    const board = await readBoard(file);
    expect(shared).not.toContain("W9999");
    expect(board).toContain(text);
    expect(board).not.toMatch(/Ã|â€™|â€œ|â€|ÃƒÂ¢/);
  });

  it("rejects explicit scratch control paths under a worktree .tandem directory", async () => {
    const repo = path.join(tmpdir(), `tandem-direction-guard-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const canonical = path.join(repo, ".tandem", "shared-control", "SHARED_DIRECTION.md");
    const wrong = path.join(repo, ".tandem", "direction.txt");
    await mkdir(path.dirname(canonical), { recursive: true });
    await writeFile(canonical, boardText("- [ ] W0001 | P1 | Real item | QUEUED added=2026-07-18T00:00:00Z"), "utf8");
    await writeFile(wrong, boardText("- [ ] W9999 | P1 | Scratch item | QUEUED added=2026-07-18T00:00:00Z"), "utf8");
    await execa("git", ["init"], { cwd: repo });

    await expect(execa("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
      "-Action", "Show", "-ControlPath", wrong,
    ], { cwd: repo })).rejects.toThrow(/canonical shared board/);

    const shown = await execa("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
      "-Action", "Show", "-ControlPath", canonical,
    ], { cwd: repo });
    expect(shown.stdout).toContain("Real item");
  });

  it("removes a queued item while preserving its original line and reason", async () => {
    const file = await boardFile();
    const added = JSON.parse((await direction(file, "-Action", "Add", "-Priority", "P2", "-Text", "Scratch request")).stdout);
    const before = await readBoard(file);
    const original = before.split(/\r?\n/).find((line) => line.startsWith(`- [ ] ${added.id} |`));

    await direction(file, "-Action", "Remove", "-Id", added.id, "-Note", "acceptance cleanup");

    const after = await readBoard(file);
    expect(after.split(/\r?\n/).filter((line) => line.startsWith(`- [ ] ${added.id} |`))).toEqual([]);
    expect(after).toContain("## Removed");
    expect(after).toContain(`- id=${added.id} | removed=`);
    expect(after).toContain("note=acceptance cleanup");
    expect(after).toContain(`  original: ${original}`);
    expect([...Buffer.from(after).subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);

    const next = JSON.parse((await direction(file, "-Action", "Add", "-Text", "Next request")).stdout);
    expect(next.id).toBe("W0002");
  });

  it("refuses to remove an item owned by an in-progress turn", async () => {
    const file = await boardFile();
    const added = JSON.parse((await direction(file, "-Action", "Add", "-Text", "Owned request")).stdout);
    await direction(file, "-Action", "Start", "-Id", added.id, "-Role", "A");

    await expect(direction(file, "-Action", "Remove", "-Id", added.id, "-Note", "must not disappear"))
      .rejects.toThrow(/Cannot remove .* while it is IN_PROGRESS/);

    expect(await readBoard(file)).toContain(`${added.id} | P1 | Owned request | IN_PROGRESS role=A`);
  });
});
describeWindows("reciprocal direction epics", () => {
  it("D175: normal queued work normalizes into an autonomous plan item with the same ID", async () => {
    const file = await boardFile();
    const added = JSON.parse((await direction(file, "-Action", "Add", "-Priority", "P0", "-Text", "Repair the broad reciprocal workflow")).stdout);

    await direction(file, "-Action", "NormalizeQueued", "-Id", added.id);
    await direction(file, "-Action", "Start", "-Id", added.id, "-Role", "A");

    const plan = `process/reciprocal/epics/${added.id}-plan.md`;
    const board = await readBoard(file);
    expect(board).toContain(`plan=${plan}`);
    expect(board).toContain(`${added.id} | P0 | Repair the broad reciprocal workflow | IN_PROGRESS epic=true autonomy=full phase=PLAN revision=1 completed=0 plan=${plan} role=A`);
    expect(board).not.toContain("W0002 | P0 | Repair the broad reciprocal workflow");
  });

  it("D176: normalization is idempotent and does not infer authority gates from prose", async () => {
    const file = await boardFile();
    const added = JSON.parse((await direction(file, "-Action", "Add", "-Priority", "P0", "-Text", "Discover Python, permission state, sandbox helper, and never weaken sandboxing")).stdout);

    await direction(file, "-Action", "NormalizeQueued", "-Id", added.id);
    await direction(file, "-Action", "NormalizeQueued", "-Id", added.id);

    const plan = `process/reciprocal/epics/${added.id}-plan.md`;
    const board = await readBoard(file);
    expect(board).toContain(`${added.id} | P0 | Discover Python, permission state, sandbox helper, and never weaken sandboxing | QUEUED epic=true autonomy=full phase=PLAN revision=1 completed=0 plan=${plan}`);
    expect(board).not.toContain("safety=security-surface");
    expect(board.split(/\r?\n/).filter((line) => line.startsWith(`- [ ] ${added.id} |`))).toHaveLength(1);
  });

  it("D176: migrates a false-positive authority gate in place while preserving owner and plan", async () => {
    const file = await boardFile();
    const plan = "process/reciprocal/epics/W0027-plan.md";
    await writeFile(wishlistFile(file), [
      "# Tandem Reciprocal: Wishlist And Progress",
      "",
      "<!-- wishlist-items -->",
      `- [ ] W0027 | P0 | Discover Python permission state and never weaken sandboxing | IN_PROGRESS epic=true autonomy=plan-gated safety=security-surface phase=PLAN revision=1 completed=0 plan=${plan} role=A started=2026-07-22T03:25:39Z`,
      "",
    ].join("\n"), "utf8");

    await direction(file, "-Action", "MigrateAuthorityMetadata", "-Id", "W0027");

    const board = await readBoard(file);
    expect(board).toContain(`W0027 | P0 | Discover Python permission state and never weaken sandboxing | IN_PROGRESS epic=true autonomy=full phase=PLAN revision=1 completed=0 plan=${plan} role=A started=2026-07-22T03:25:39Z`);
    expect(board).not.toContain("safety=security-surface");
  });

  it("gates step turns on plan approval and advances one accepted step at a time", async () => {
    const file = await boardFile();
    const added = JSON.parse((await direction(file, "-Action", "Add", "-Epic", "-Text", "Large stable feature")).stdout);
    const plan = `process/reciprocal/epics/${added.id}-plan.md`;

    await direction(file, "-Action", "Start", "-Id", added.id, "-Role", "A");
    await direction(file, "-Action", "Candidate", "-Id", added.id, "-Commit", "plan123", "-Steps", "2", "-Plan", plan);
    await expect(direction(file, "-Action", "Start", "-Id", added.id, "-Role", "B"))
      .rejects.toThrow(/plan must be approved by a human/);

    await direction(file, "-Action", "ApprovePlan", "-Id", added.id, "-Note", "bounded and stable");
    await direction(file, "-Action", "Start", "-Id", added.id, "-Role", "B");
    expect(await readBoard(file)).toContain(`IN_PROGRESS epic=true phase=STEP revision=1 completed=0 step=1/2 plan=${plan} role=B`);

    await direction(file, "-Action", "Candidate", "-Id", added.id, "-Commit", "step1");
    await direction(file, "-Action", "AcceptStep", "-Id", added.id, "-Commit", "step1");
    expect(await readBoard(file)).toContain(`IN_PROGRESS epic=true phase=STEP revision=1 completed=1 step=1/2 next=2/2 plan=${plan}`);

    await direction(file, "-Action", "Start", "-Id", added.id, "-Role", "A");
    await direction(file, "-Action", "Candidate", "-Id", added.id, "-Commit", "step2");
    await direction(file, "-Action", "Complete", "-Id", added.id, "-Commit", "step2");
    expect(await readBoard(file)).toContain(`DONE stable=step2 completed=`);
  }, 30_000);

  it("D177 declares, approves, and denies exact step authority without broad prose grants", async () => {
    const file = await boardFile();
    const added = JSON.parse((await direction(file, "-Action", "Add", "-Epic", "-Text", "Authority gated feature")).stdout);
    const plan = `process/reciprocal/epics/${added.id}-plan.md`;

    await direction(file, "-Action", "Start", "-Id", added.id, "-Role", "A");
    await direction(file, "-Action", "Candidate", "-Id", added.id, "-Commit", "plan123", "-Steps", "2", "-Plan", plan);
    await direction(file, "-Action", "ApprovePlan", "-Id", added.id);
    await direction(file, "-Action", "Start", "-Id", added.id, "-Role", "A");

    await expect(direction(file, "-Action", "DeclareAuthority", "-Id", added.id, "-Text", "permission__all__step1__resumeStep1"))
      .rejects.toThrow(/must be exact/);
    await direction(file, "-Action", "DeclareAuthority", "-Id", added.id, "-Text", "permission__enableLoopback__step1__resumeStep1");
    expect(await readBoard(file)).toContain("authority=permission action=enableLoopback checkpoint=step1 resume=resumeStep1 authorityStatus=pending");
    await expect(direction(file, "-Action", "Start", "-Id", added.id, "-Role", "B"))
      .rejects.toThrow(/pending exact authority/);

    await expect(direction(file, "-Action", "ApproveAuthority", "-Id", added.id))
      .rejects.toThrow(/trusted relay authority proof/);
    await expect(direction(file, "-Action", "DenyAuthority", "-Id", added.id, "-Note", "too risky"))
      .rejects.toThrow(/trusted relay authority proof/);
    const forgedProof = path.join(path.dirname(file), "forged-authority-proof.json");
    await writeFile(forgedProof, JSON.stringify({
      requestId: "attacker",
      decision: "approve",
      id: added.id,
      owner: "A",
      authority: "permission",
      action: "enableLoopback",
      checkpoint: "step1",
      resume: "resumeStep1",
      expiresAtUtc: new Date(Date.now() + 120_000).toISOString(),
      signature: "0".repeat(64),
    }), "utf8");
    await expect(direction(file, "-Action", "ApproveAuthority", "-Id", added.id, "-AuthorityProofPath", forgedProof))
      .rejects.toThrow(/trusted relay authority signing secret/);
  }, 30_000);

  it("D178 loads the canonical taxonomy fixture before mutating direction state", async () => {
    const file = await boardFile();
    const taxonomy = path.join(path.dirname(file), "gate-taxonomy.json");
    await writeFile(taxonomy, JSON.stringify({
      version: 1,
      categories: {
        autoRecoverablePrerequisite: "fixture-auto",
        hardBlocked: "fixture-hard",
        hardHumanGate: "fixture-human",
        waitingNotBlocked: "fixture-wait",
      },
      pauseOrigins: { human: "fixture-human", machine: "fixture-machine", unknown: "fixture-unknown" },
      pauseReasonCodes: {
        explicitHumanPause: "fixture-human-pause",
        resumeCircuitBreaker: "fixture-repeat",
        candidateFailure: "fixture-candidate",
      },
      displayStates: {
        working: "fixture-working",
        testing: "fixture-testing",
        waitingForReview: "fixture-review",
        humanPaused: "fixture-human-paused",
        machineBlocked: "fixture-machine-blocked",
        hardBlocked: "fixture-hard-blocked",
        retryBackoff: "fixture-backoff",
        retryingPrerequisite: "fixture-retry",
        planning: "fixture-planning",
        unknown: "fixture-unknown",
        waitingNotBlocked: "fixture-waiting",
      },
    }), "utf8");

    const added = JSON.parse((await directionWithEnv(file, { TANDEM_RECIPROCAL_TAXONOMY: taxonomy }, "-Action", "Add", "-Text", "taxonomy-backed item")).stdout);
    expect(added.id).toMatch(/^W\d+$/);

    await writeFile(taxonomy, JSON.stringify({
      version: 1,
      categories: { autoRecoverablePrerequisite: "fixture-auto" },
      pauseOrigins: { human: "fixture-human", machine: "fixture-machine", unknown: "fixture-unknown" },
      pauseReasonCodes: {
        explicitHumanPause: "fixture-human-pause",
        resumeCircuitBreaker: "fixture-repeat",
        candidateFailure: "fixture-candidate",
      },
      displayStates: {
        working: "fixture-working",
        testing: "fixture-testing",
        waitingForReview: "fixture-review",
        humanPaused: "fixture-human-paused",
        machineBlocked: "fixture-machine-blocked",
        hardBlocked: "fixture-hard-blocked",
        retryBackoff: "fixture-backoff",
        retryingPrerequisite: "fixture-retry",
        planning: "fixture-planning",
        unknown: "fixture-unknown",
        waitingNotBlocked: "fixture-waiting",
      },
    }), "utf8");

    await expect(directionWithEnv(file, { TANDEM_RECIPROCAL_TAXONOMY: taxonomy }, "-Action", "Add", "-Text", "must fail")).rejects.toThrow(/categories\.hardBlocked/);
  }, 30_000);

  it("requires plan revisions to return through the human plan gate", async () => {
    const file = await boardFile();
    const added = JSON.parse((await direction(file, "-Action", "Add", "-Epic", "-Text", "Replanned feature")).stdout);
    const plan = `process/reciprocal/epics/${added.id}-plan.md`;
    await direction(file, "-Action", "Start", "-Id", added.id, "-Role", "A");
    await direction(file, "-Action", "Candidate", "-Id", added.id, "-Commit", "plan1", "-Steps", "3", "-Plan", plan);
    await direction(file, "-Action", "ApprovePlan", "-Id", added.id);
    await direction(file, "-Action", "Start", "-Id", added.id, "-Role", "A");
    await direction(file, "-Action", "Candidate", "-Id", added.id, "-Commit", "plan2", "-Steps", "4", "-Plan", plan, "-PlanRevision");

    const revised = await readBoard(file);
    expect(revised).toContain("CANDIDATE epic=true candidate=PLAN revision=2");
    await expect(direction(file, "-Action", "Start", "-Id", added.id, "-Role", "B"))
      .rejects.toThrow(/plan must be approved by a human/);
  }, 30_000);

  it("preserves epic step metadata through block and requeue recovery", async () => {
    const file = await boardFile();
    const added = JSON.parse((await direction(file, "-Action", "Add", "-Epic", "-Text", "Recoverable epic")).stdout);
    const plan = `process/reciprocal/epics/${added.id}-plan.md`;
    await direction(file, "-Action", "Start", "-Id", added.id, "-Role", "A");
    await direction(file, "-Action", "Candidate", "-Id", added.id, "-Commit", "plan1", "-Steps", "2", "-Plan", plan);
    await direction(file, "-Action", "ApprovePlan", "-Id", added.id);
    await direction(file, "-Action", "Start", "-Id", added.id, "-Role", "A");
    await direction(file, "-Action", "Candidate", "-Id", added.id, "-Commit", "step1");
    await direction(file, "-Action", "AcceptStep", "-Id", added.id, "-Commit", "step1");
    await direction(file, "-Action", "Block", "-Id", added.id, "-Note", "human dependency");
    await direction(file, "-Action", "Requeue", "-Id", added.id, "-Note", "dependency resolved");

    const recovered = await readBoard(file);
    expect(recovered).toContain(`PLAN_APPROVED epic=true revision=1 completed=1 steps=2 next=2/2 plan=${plan}`);
  }, 30_000);

  it("auto-approves an independently accepted fully autonomous plan and audits it", async () => {
    const file = await boardFile();
    const stable = await acceptedCommit();
    const added = JSON.parse((await direction(file, "-Action", "Add", "-Epic", "-Autonomy", "full", "-Text", "Large autonomous feature")).stdout);
    const plan = `process/reciprocal/epics/${added.id}-plan.md`;
    await direction(file, "-Action", "Start", "-Id", added.id, "-Role", "A");
    await direction(file, "-Action", "Candidate", "-Id", added.id, "-Commit", stable, "-Steps", "2", "-Plan", plan);
    await direction(file, "-Action", "AutoApprovePlan", "-Id", added.id, "-Commit", stable);
    await direction(file, "-Action", "Start", "-Id", added.id, "-Role", "B");

    const board = await readBoard(file);
    expect(board).toContain("IN_PROGRESS epic=true autonomy=full phase=STEP");
    expect(board).toContain(`step=1/2 plan=${plan} role=B`);
    const audit = await readFile(path.join(path.dirname(file), "CONTROL_PANEL_AUDIT.jsonl"), "utf8");
    expect(audit).toContain('"action":"wishlist.planAutoApprove"');
    expect(audit).toContain('"reason":"plan auto-approved (item autonomy: full)"');
  });

  it("canonicalizes an accepted abbreviated plan commit during auto-approval", async () => {
    const file = await boardFile();
    const stable = await acceptedCommit();
    const added = JSON.parse((await direction(file, "-Action", "Add", "-Epic", "-Autonomy", "full", "-Text", "Abbreviated candidate")).stdout);
    const plan = `process/reciprocal/epics/${added.id}-plan.md`;
    await direction(file, "-Action", "Start", "-Id", added.id, "-Role", "A");
    await direction(file, "-Action", "Candidate", "-Id", added.id, "-Commit", stable.slice(0, 7), "-Steps", "3", "-CompletedSteps", "2", "-Plan", plan);
    await direction(file, "-Action", "AutoApprovePlan", "-Id", added.id, "-Commit", stable);

    expect(await readBoard(file)).toContain(`PLAN_APPROVED epic=true autonomy=full revision=1 completed=2 steps=3 next=3/3 plan=${plan} commit=${stable}`);
  });

  it("uses the board autonomy default and allows sensitive prose unless authority metadata is explicit", async () => {
    const file = await boardFile();
    const stable = await acceptedCommit();
    const initial = await readFile(file, "utf8");
    await writeFile(file, initial.replace("## Human Guardrails", "AutonomyDefault: autonomous\n\n## Human Guardrails"), "utf8");
    const ordinary = JSON.parse((await direction(file, "-Action", "Add", "-Epic", "-Text", "Large reporting feature")).stdout);
    const ordinaryPlan = `process/reciprocal/epics/${ordinary.id}-plan.md`;
    await direction(file, "-Action", "Start", "-Id", ordinary.id, "-Role", "A");
    await direction(file, "-Action", "Candidate", "-Id", ordinary.id, "-Commit", stable, "-Steps", "2", "-Plan", ordinaryPlan);
    await direction(file, "-Action", "AutoApprovePlan", "-Id", ordinary.id, "-Commit", stable);

    const sensitive = JSON.parse((await direction(file, "-Action", "Add", "-Epic", "-Text", "Add remote control authentication")).stdout);
    const board = await readBoard(file);
    expect(board).toContain(`${sensitive.id} | P1 | Add remote control authentication | QUEUED epic=true phase=PLAN`);
    const explicitFull = JSON.parse((await direction(file, "-Action", "Add", "-Epic", "-Autonomy", "full", "-Text", "Change credentials in a later explicit authority step")).stdout);
    expect(await readBoard(file)).toContain(`${explicitFull.id} | P1 | Change credentials in a later explicit authority step | QUEUED epic=true autonomy=full phase=PLAN`);
  }, 30_000);

  it("treats requeue with a note as retroactive rejection of an autonomous plan", async () => {
    const file = await boardFile();
    const stable = await acceptedCommit();
    const added = JSON.parse((await direction(file, "-Action", "Add", "-Epic", "-Autonomy", "full", "-Text", "Revisable autonomous feature")).stdout);
    const plan = `process/reciprocal/epics/${added.id}-plan.md`;
    await direction(file, "-Action", "Start", "-Id", added.id, "-Role", "A");
    await direction(file, "-Action", "Candidate", "-Id", added.id, "-Commit", stable, "-Steps", "2", "-Plan", plan);
    await direction(file, "-Action", "AutoApprovePlan", "-Id", added.id, "-Commit", stable);
    await direction(file, "-Action", "Start", "-Id", added.id, "-Role", "B");
    await direction(file, "-Action", "Requeue", "-Id", added.id, "-Note", "change the second step");

    expect(await readBoard(file)).toContain(`QUEUED epic=true autonomy=full phase=PLAN revision=2 completed=0 plan=${plan} note=change the second step`);
  }, 30_000);
});

describeWindows("reciprocal direction artifact completion", () => {
  it("D162: marks queued artifact-only work done with explicit source and evidence metadata", async () => {
    const file = await boardFile();
    const added = JSON.parse((await direction(file, "-Action", "Add", "-Priority", "P0", "-Text", "Build candidate preview", "-Commit", "feed4343ec17e79cb8398c069120c100c7b2f1be", "-ArtifactKind", "candidate-preview")).stdout);

    await direction(
      file,
      "-Action", "ArtifactComplete",
      "-Id", added.id,
      "-Role", "A",
      "-Commit", "feed4343ec17e79cb8398c069120c100c7b2f1be",
      "-ArtifactKind", "candidate-preview",
      "-Evidence", "sha256:abcdef123456",
    );

    const board = await readBoard(file);
    expect(board).toContain(`- [x] ${added.id} | P0 | Build candidate preview | DONE artifact=candidate-preview source=feed4343ec17e79cb8398c069120c100c7b2f1be evidence=sha256:abcdef123456 role=A completed=`);
  });

  it("D162: refuses artifact completion for work owned by another role", async () => {
    const file = await boardFile();
    const added = JSON.parse((await direction(file, "-Action", "Add", "-Text", "Owned preview", "-Commit", "abc1234", "-ArtifactKind", "candidate-preview")).stdout);
    await direction(file, "-Action", "Start", "-Id", added.id, "-Role", "B");

    await expect(direction(
      file,
      "-Action", "ArtifactComplete",
      "-Id", added.id,
      "-Role", "A",
      "-Commit", "abc1234",
      "-ArtifactKind", "candidate-preview",
      "-Evidence", "sha256:abcdef123456",
    )).rejects.toThrow(/owned by role B/);
  });

  it("D162: retires an exact nonterminal rejected origin with an audit note", async () => {
    const file = await boardFile();
    const added = JSON.parse((await direction(file, "-Action", "Add", "-Text", "Preview origin")).stdout);
    await direction(file, "-Action", "Start", "-Id", added.id, "-Role", "A");

    await direction(file, "-Action", "Retire", "-Id", added.id, "-Note", "rejected-review-followup-W0002");

    const board = await readBoard(file);
    expect(board).toContain("## Retired");
    expect(board).toContain(`- id=${added.id} | retired=`);
    expect(board).toContain("note=rejected-review-followup-W0002");
    expect(board).toContain(`original: - [ ] ${added.id} | P1 | Preview origin | IN_PROGRESS role=A`);
  });

  it("D162: refuses to retire already terminal artifact work", async () => {
    const file = await boardFile();
    const added = JSON.parse((await direction(file, "-Action", "Add", "-Text", "Done preview", "-Commit", "abc1234", "-ArtifactKind", "candidate-preview")).stdout);
    await direction(file, "-Action", "ArtifactComplete", "-Id", added.id, "-Role", "A", "-Commit", "abc1234", "-ArtifactKind", "candidate-preview", "-Evidence", "sha256:abcdef123456");

    await expect(direction(file, "-Action", "Retire", "-Id", added.id, "-Note", "do-not-retire"))
      .rejects.toThrow(/already terminal/);
  });

  it("D162: leaves W0016-style plan-approved metadata unchanged during unrelated artifact cleanup", async () => {
    const file = await boardFile();
    await writeFile(file, boardText([
      "- [ ] W0016 | P1 | Telegram remote control | PLAN_APPROVED epic=true autonomy=plan-gated revision=1 completed=2 steps=3 next=3/3 plan=process/reciprocal/epics/W0016-plan.md commit=abc123 approved=2026-07-20T00:00:00Z",
      "- [ ] W0099 | P0 | Build candidate preview | QUEUED artifact=candidate-preview source=feed434 declared=2026-07-20T00:00:00Z",
    ].join("\n")), "utf8");

    await direction(
      file,
      "-Action", "ArtifactComplete",
      "-Id", "W0099",
      "-Role", "A",
      "-Commit", "feed434",
      "-ArtifactKind", "candidate-preview",
      "-Evidence", "sha256:abcdef123456",
    );

    const board = await readBoard(file);
    expect(board).toContain("- [ ] W0016 | P1 | Telegram remote control | PLAN_APPROVED epic=true autonomy=plan-gated revision=1 completed=2 steps=3 next=3/3 plan=process/reciprocal/epics/W0016-plan.md commit=abc123 approved=2026-07-20T00:00:00Z");
  });

  it("D164: creates declared artifact work atomically and refuses manual conversion by default", async () => {
    const file = await boardFile();
    const normal = JSON.parse((await direction(file, "-Action", "Add", "-Text", "Normal source work")).stdout);
    await expect(direction(file, "-Action", "DeclareArtifact", "-Id", normal.id, "-Commit", "abc1234", "-ArtifactKind", "candidate-preview"))
      .rejects.toThrow(/reserved for trusted control-plane/);

    const artifact = JSON.parse((await direction(file, "-Action", "Add", "-Text", "Build preview", "-Commit", "feed434", "-ArtifactKind", "candidate-preview")).stdout);
    const board = await readBoard(file);
    expect(board).toContain(`${artifact.id} | P1 | Build preview | QUEUED artifact=candidate-preview source=feed434 declared=`);
  });

  it("D164: uses TANDEM_RECIPROCAL_ROOT as the default board for isolated relay worktrees", async () => {
    const repo = path.join(tmpdir(), `tandem-direction-env-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const relayRoot = path.join(tmpdir(), `tandem-direction-relay-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const file = path.join(relayRoot, "control", "SHARED_DIRECTION.md");
    await mkdir(repo, { recursive: true });
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(path.join(repo, "README.md"), "test\n", "utf8");
    await writeFile(file, boardText(), "utf8");
    await execa("git", ["init"], { cwd: repo });

    const result = await execa("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
      "-Action", "Add", "-Text", "Env routed artifact", "-Commit", "feed434", "-ArtifactKind", "candidate-preview",
    ], { cwd: repo, env: { TANDEM_RECIPROCAL_ROOT: relayRoot } });

    const added = JSON.parse(result.stdout);
    const board = await readBoard(file);
    expect(added.directionPath).toBe(file);
    expect(added.path).toBe(wishlistFile(file));
    expect(board).toContain(`${added.id} | P1 | Env routed artifact | QUEUED artifact=candidate-preview source=feed434 declared=`);
  });
});
