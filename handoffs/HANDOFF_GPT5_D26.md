# Handoff to GPT-5 — Round D26 (session action buttons clipped invisible — measured root cause)

D25-3 was specified but NOT implemented (the D25 commit covers only D25-1/D25-2). The reviewer
has now measured the exact defect live (CDP, dpr 1.5):

- `.sideList { display: grid; max-height: 132px; overflow: auto }` compresses its rows: with 3
  sessions, each `.sessionRow` is squeezed to 41px (3×41 + 2×5 gap = 132) while its grid content
  is 61px (title 33.7px + actions 27.3px).
- `.sessionRow { overflow: hidden }` (added in D15-2) then clips the bottom 20px — the entire
  Rename/Archive/Delete button row renders below the clip line: present in DOM, clickable
  programmatically, INVISIBLE to users at any window size. This is the user's thrice-reported
  "no delete button." All prior "session buttons work" verifications exercised DOM mechanics,
  not pixels.

## D26-1: Fix the list layout so rows keep natural height
- `.sideList`: stop compressing rows — e.g. `display: flex; flex-direction: column;` (or
  `grid-auto-rows: max-content`), keep `overflow-y: auto`, and raise `max-height` to something
  useful (~320px) so 3–4 full rows are visible before scrolling.
- `.sessionRow`: natural height; keep horizontal overflow control without vertical clipping
  (`overflow-x: hidden; overflow-y: visible` or restructure so the D15-2 rename-input fix is
  preserved — re-verify the rename input stays on-screen after the change).
- Apply D25-3's contrast improvements to the buttons at the same time (visible borders/text).

## Acceptance (geometry, not vibes)
tsc + `npm test` green; commit `D26-1:`. The reviewer will re-run the geometry probe and
requires for every visible session row: each action button's bounding rect fully inside the
row's rect and the viewport (`visible: true` in the probe), at dpr 1.5, with 3+ sessions
listed; plus a screenshot check; plus the rename input still fully on-screen when opened.
