import type { DesktopTheme } from "../../../src/config/schema.js";

export type ResolvedTheme = "light" | "dark";

export const DAY_START_HOUR = 6;
export const NIGHT_START_HOUR = 19;
export const THEME_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export function themeForLocalTime(date: Date): ResolvedTheme {
  const hour = date.getHours();
  return hour >= DAY_START_HOUR && hour < NIGHT_START_HOUR ? "light" : "dark";
}

export function resolveDesktopTheme(preference: DesktopTheme, date = new Date()): ResolvedTheme {
  return preference === "auto" ? themeForLocalTime(date) : preference;
}

export function applyDesktopTheme(preference: DesktopTheme, date = new Date()): ResolvedTheme {
  const resolved = resolveDesktopTheme(preference, date);
  document.documentElement.dataset.theme = resolved;
  return resolved;
}
