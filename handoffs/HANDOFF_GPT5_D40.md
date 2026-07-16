# Handoff to GPT-5 — Round D40 (sidebar has no scrollbar; content becomes unreachable)

User report (root cause reviewer-confirmed in `app/renderer/src/styles.css`): the left sidebar
(`<aside className="sidebar">` in `app/renderer/src/main.tsx:805`) is a single flex-column
holding everything — brand, project path, folder-picker button, session controls/list, goals
panel, schedules panel — with `.sidebar { overflow: hidden }` (no scroll mechanism at all). The
nested `.sideList` (session rows specifically) already scrolls internally (fixed in D26), but the
sidebar AS A WHOLE has no way to reach content once brand+sessions+goals+schedules together
exceed the window's height — it just clips silently. This didn't reproduce in the reviewer's
sparse test session (1 goal, 1 session fit within 697px) but will reproduce for any real user
with an accumulated set of sessions/goals/schedules, or a shorter window.

## D40-1: Make the sidebar scroll as a whole
In `app/renderer/src/styles.css`, change `.sidebar`'s `overflow: hidden` to
`overflow-y: auto; overflow-x: hidden` (keep horizontal clipping — do not reintroduce the D27
horizontal-scroll regression). Give the scrollbar visible affordance consistent with the rest of
the app's dark theme if a scrollbar-styling convention already exists elsewhere in this
stylesheet (check `.sideList`'s existing scroll styling, if any, and match it); otherwise the
browser default is acceptable.

Do not restructure the JSX (e.g. into a fixed header + scrollable body) this round — that's a
larger change than needed. A single whole-sidebar scrollbar is the correct, minimal fix.

## Acceptance
tsc + `npm test` green; commit `D40-1:`. Reviewer will verify by adding enough goals/sessions in
a live session to force overflow (or by shrinking the window) and confirming a scrollbar appears
and all sidebar content (including the bottom-most schedule/goal rows) becomes reachable, while
confirming the D27 no-horizontal-scroll invariant still holds.
