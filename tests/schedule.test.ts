import { describe, expect, it } from "vitest";
import { missedSchedule, previousScheduledTime } from "../src/commands/schedule.js";

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
});
