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

describeWindows("reciprocal direction wishlist removal", () => {
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
  });

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
});
