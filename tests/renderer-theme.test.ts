import { describe, expect, it } from "vitest";
import { resolveDesktopTheme, themeForLocalTime } from "../app/renderer/src/theme.js";

function localDate(hour: number, minute = 0): Date {
  return new Date(2026, 6, 11, hour, minute);
}

describe("desktop theme resolution", () => {
  it("switches to day at 06:00 and night at 19:00 local time", () => {
    expect(themeForLocalTime(localDate(5, 59))).toBe("dark");
    expect(themeForLocalTime(localDate(6))).toBe("light");
    expect(themeForLocalTime(localDate(6, 1))).toBe("light");
    expect(themeForLocalTime(localDate(18, 59))).toBe("light");
    expect(themeForLocalTime(localDate(19))).toBe("dark");
    expect(themeForLocalTime(localDate(19, 1))).toBe("dark");
  });

  it("honors explicit overrides and resolves auto from local time", () => {
    expect(resolveDesktopTheme("light", localDate(23))).toBe("light");
    expect(resolveDesktopTheme("dark", localDate(12))).toBe("dark");
    expect(resolveDesktopTheme("auto", localDate(12))).toBe("light");
    expect(resolveDesktopTheme("auto", localDate(23))).toBe("dark");
  });
});
