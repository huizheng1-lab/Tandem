import { describe, expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { listSchedules, missedSchedule, previousScheduledTime, ScheduleLoadError } from "../src/commands/schedule.js";

async function tempProject(): Promise<string> {
  const dir = path.join(tmpdir(), `tandem-schedule-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(dir, ".tandem"), { recursive: true });
  return dir;
}

describe("schedule missed-run detection", () => {
  it("detects a missed minute schedule after the previous fire time", () => {
    const now = new Date("2026-07-05T12:05:30Z");
    expect(previousScheduledTime("* * * * *", now)?.toISOString()).toBe("2026-07-05T12:05:00.000Z");
    expect(missedSchedule("* * * * *", "2026-07-05T12:04:00.000Z", now)).toBe(true);
  });

  it("does not mark missed when lastRunAt is newer than the previous scheduled time", () => {
    const now = new Date("2026-07-05T12:05:30Z");
    expect(missedSchedule("* * * * *", "2026-07-05T12:05:01.000Z", now)).toBe(false);
  });

  it("handles six-field second schedules", () => {
    const now = new Date("2026-07-05T12:05:31Z");
    expect(previousScheduledTime("*/10 * * * * *", now)?.toISOString()).toBe("2026-07-05T12:05:30.000Z");
    expect(missedSchedule("*/10 * * * * *", "2026-07-05T12:05:20.000Z", now)).toBe(true);
  });

  it("D191: rejects a bare schedules object with an identifiable load failure", async () => {
    const cwd = await tempProject();
    await writeFile(path.join(cwd, ".tandem", "schedules.json"), JSON.stringify({ id: "relay-a", cron: "* * * * *", prompt: "run", createdAt: "now" }), "utf8");

    await expect(listSchedules(cwd)).rejects.toThrow(ScheduleLoadError);
    await expect(listSchedules(cwd)).rejects.toThrow(/Malformed schedules\.json.*expected an array/i);
  });

  it("D191: rejects invalid schedule entries with the schedules file path", async () => {
    const cwd = await tempProject();
    const filePath = path.join(cwd, ".tandem", "schedules.json");
    await writeFile(filePath, JSON.stringify([{ id: "relay-a", cron: "* * * * *", createdAt: "now" }]), "utf8");

    await expect(listSchedules(cwd)).rejects.toThrow(filePath);
    await expect(listSchedules(cwd)).rejects.toThrow(/prompt: Required/i);
  });

  it("D191: accepts valid schedule arrays", async () => {
    const cwd = await tempProject();
    await writeFile(path.join(cwd, ".tandem", "schedules.json"), JSON.stringify([{ id: "relay-a", cron: "* * * * *", prompt: "run", createdAt: "now" }]), "utf8");

    await expect(listSchedules(cwd)).resolves.toMatchObject([{ id: "relay-a", prompt: "run" }]);
  });

  it("D191: PowerShell schedule edits preserve single-entry array shape", async () => {
    const cwd = await tempProject();
    const filePath = path.join(cwd, ".tandem", "schedules.json");
    await writeFile(filePath, JSON.stringify([{ id: "relay-a", cron: "* * * * *", prompt: "old", createdAt: "now", lastRunAt: "then" }], null, 2), "utf8");

    await execa("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.resolve("scripts/update-tandem-schedule.ps1"),
      "-SchedulePath",
      filePath,
      "-Id",
      "relay-a",
      "-Prompt",
      "new"
    ]);

    const rewritten = JSON.parse(await readFile(filePath, "utf8"));
    expect(Array.isArray(rewritten)).toBe(true);
    expect(rewritten).toHaveLength(1);
    expect(rewritten[0]).toMatchObject({ id: "relay-a", prompt: "new", lastRunAt: "then" });
  });
});
