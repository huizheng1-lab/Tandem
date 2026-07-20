import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const describeWindows = process.platform === "win32" ? describe : describe.skip;
const scriptPath = path.resolve("scripts", "reciprocal-direction.ps1");

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
    const before = await readFile(file, "utf8");
    const original = before.split(/\r?\n/).find((line) => line.startsWith(`- [ ] ${added.id} |`));

    await direction(file, "-Action", "Remove", "-Id", added.id, "-Note", "acceptance cleanup");

    const after = await readFile(file, "utf8");
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

    expect(await readFile(file, "utf8")).toContain(`${added.id} | P1 | Owned request | IN_PROGRESS role=A`);
  });
});

describeWindows("reciprocal direction epics", () => {
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
    expect(await readFile(file, "utf8")).toContain(`IN_PROGRESS epic=true phase=STEP revision=1 completed=0 step=1/2 plan=${plan} role=B`);

    await direction(file, "-Action", "Candidate", "-Id", added.id, "-Commit", "step1");
    await direction(file, "-Action", "AcceptStep", "-Id", added.id, "-Commit", "step1");
    expect(await readFile(file, "utf8")).toContain(`IN_PROGRESS epic=true phase=STEP revision=1 completed=1 step=1/2 next=2/2 plan=${plan}`);

    await direction(file, "-Action", "Start", "-Id", added.id, "-Role", "A");
    await direction(file, "-Action", "Candidate", "-Id", added.id, "-Commit", "step2");
    await direction(file, "-Action", "Complete", "-Id", added.id, "-Commit", "step2");
    expect(await readFile(file, "utf8")).toContain(`DONE stable=step2 completed=`);
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

    const revised = await readFile(file, "utf8");
    expect(revised).toContain("CANDIDATE epic=true candidate=PLAN revision=2");
    await expect(direction(file, "-Action", "Start", "-Id", added.id, "-Role", "B"))
      .rejects.toThrow(/plan must be approved by a human/);
  });

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

    const recovered = await readFile(file, "utf8");
    expect(recovered).toContain(`PLAN_APPROVED epic=true revision=1 completed=1 steps=2 next=2/2 plan=${plan}`);
  });

  it("auto-approves an independently accepted fully autonomous plan and audits it", async () => {
    const file = await boardFile();
    const stable = await acceptedCommit();
    const added = JSON.parse((await direction(file, "-Action", "Add", "-Epic", "-Autonomy", "full", "-Text", "Large autonomous feature")).stdout);
    const plan = `process/reciprocal/epics/${added.id}-plan.md`;
    await direction(file, "-Action", "Start", "-Id", added.id, "-Role", "A");
    await direction(file, "-Action", "Candidate", "-Id", added.id, "-Commit", stable, "-Steps", "2", "-Plan", plan);
    await direction(file, "-Action", "AutoApprovePlan", "-Id", added.id, "-Commit", stable);
    await direction(file, "-Action", "Start", "-Id", added.id, "-Role", "B");

    const board = await readFile(file, "utf8");
    expect(board).toContain("IN_PROGRESS epic=true autonomy=full phase=STEP");
    expect(board).toContain(`step=1/2 plan=${plan} role=B`);
    const audit = await readFile(path.join(path.dirname(file), "CONTROL_PANEL_AUDIT.jsonl"), "utf8");
    expect(audit).toContain('"action":"wishlist.planAutoApprove"');
    expect(audit).toContain('"reason":"plan auto-approved (item autonomy: full)"');
  });

  it("uses the board autonomy default and keeps security-surface epics gated", async () => {
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
    const board = await readFile(file, "utf8");
    expect(board).toContain(`${sensitive.id} | P1 | Add remote control authentication | QUEUED epic=true autonomy=plan-gated safety=security-surface`);
    await expect(direction(file, "-Action", "Add", "-Epic", "-Autonomy", "full", "-Text", "Change credentials"))
      .rejects.toThrow(/Security-surface epics must remain plan-gated/);
  });

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

    expect(await readFile(file, "utf8")).toContain(`QUEUED epic=true autonomy=full phase=PLAN revision=2 completed=0 plan=${plan} note=change the second step`);
  });
});

describeWindows("reciprocal direction artifact completion", () => {
  it("D162: marks queued artifact-only work done with explicit source and evidence metadata", async () => {
    const file = await boardFile();
    const added = JSON.parse((await direction(file, "-Action", "Add", "-Priority", "P0", "-Text", "Build candidate preview")).stdout);

    await direction(
      file,
      "-Action", "ArtifactComplete",
      "-Id", added.id,
      "-Role", "A",
      "-Commit", "feed4343ec17e79cb8398c069120c100c7b2f1be",
      "-ArtifactKind", "candidate-preview",
      "-Evidence", "sha256:abcdef123456",
    );

    const board = await readFile(file, "utf8");
    expect(board).toContain(`- [x] ${added.id} | P0 | Build candidate preview | DONE artifact=candidate-preview source=feed4343ec17e79cb8398c069120c100c7b2f1be evidence=sha256:abcdef123456 role=A completed=`);
  });

  it("D162: refuses artifact completion for work owned by another role", async () => {
    const file = await boardFile();
    const added = JSON.parse((await direction(file, "-Action", "Add", "-Text", "Owned preview")).stdout);
    await direction(file, "-Action", "Start", "-Id", added.id, "-Role", "B");

    await expect(direction(
      file,
      "-Action", "ArtifactComplete",
      "-Id", added.id,
      "-Role", "A",
      "-Commit", "abc123",
      "-ArtifactKind", "candidate-preview",
      "-Evidence", "sha256:abcdef123456",
    )).rejects.toThrow(/owned by role B/);
  });

  it("D162: retires an exact nonterminal rejected origin with an audit note", async () => {
    const file = await boardFile();
    const added = JSON.parse((await direction(file, "-Action", "Add", "-Text", "Preview origin")).stdout);
    await direction(file, "-Action", "Start", "-Id", added.id, "-Role", "A");

    await direction(file, "-Action", "Retire", "-Id", added.id, "-Note", "rejected-review-followup-W0002");

    const board = await readFile(file, "utf8");
    expect(board).toContain("## Retired");
    expect(board).toContain(`- id=${added.id} | retired=`);
    expect(board).toContain("note=rejected-review-followup-W0002");
    expect(board).toContain(`original: - [ ] ${added.id} | P1 | Preview origin | IN_PROGRESS role=A`);
  });

  it("D162: refuses to retire already terminal artifact work", async () => {
    const file = await boardFile();
    const added = JSON.parse((await direction(file, "-Action", "Add", "-Text", "Done preview")).stdout);
    await direction(file, "-Action", "ArtifactComplete", "-Id", added.id, "-Role", "A", "-Commit", "abc123", "-ArtifactKind", "candidate-preview", "-Evidence", "sha256:abcdef123456");

    await expect(direction(file, "-Action", "Retire", "-Id", added.id, "-Note", "do-not-retire"))
      .rejects.toThrow(/already terminal/);
  });

  it("D162: leaves W0016-style plan-approved metadata unchanged during unrelated artifact cleanup", async () => {
    const file = await boardFile();
    await writeFile(file, boardText([
      "- [ ] W0016 | P1 | Telegram remote control | PLAN_APPROVED epic=true autonomy=plan-gated revision=1 completed=2 steps=3 next=3/3 plan=process/reciprocal/epics/W0016-plan.md commit=abc123 approved=2026-07-20T00:00:00Z",
      "- [ ] W0099 | P0 | Build candidate preview | QUEUED added=2026-07-20T00:00:00Z",
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

    const board = await readFile(file, "utf8");
    expect(board).toContain("- [ ] W0016 | P1 | Telegram remote control | PLAN_APPROVED epic=true autonomy=plan-gated revision=1 completed=2 steps=3 next=3/3 plan=process/reciprocal/epics/W0016-plan.md commit=abc123 approved=2026-07-20T00:00:00Z");
  });
});
