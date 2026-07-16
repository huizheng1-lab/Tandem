# Handoff D67 (rebuild the packaged desktop app — no code changes needed)

No bug to fix this round. This is a deploy/rebuild task.

## What happened

Live-tested the packaged desktop app just now and hit the exact wrong-path-read failure
D66-1 was supposed to mitigate: 6 `Read` permission denials in a single `BuildPlanOrAnswer`
call, all against bare paths resolved against `C:\Users\huizh` (home) instead of the real
project directory (`C:\Users\huizh\tmp_test_data\tandem_hyperframe_video`) — e.g.
`C:\Users\huizh\.tandem\goals.json`, `C:\Users\huizh\scripts\verify-video.js`.

Root cause of *this specific failure* is not a code bug: the packaged app running was built
`release/win-unpacked/` on **2026-07-09 14:08**, and D66-1/D66-2 were committed at
**2026-07-10 00:26** — over 10 hours later. The running app simply predates the fix; it never
had `absolutePathsRule` or `absoluteCwdLine` in its bundle.

## What to do

1. Rebuild the packaged app from current `master` (HEAD is `33cd025`, includes through D66):
   ```
   npm run dist:app
   ```
2. Confirm the new `release/win-unpacked/resources/app.asar` timestamp is newer than
   `33cd025`'s commit time, and that `Tandem.exe` launches.
3. Sanity-check the fix actually landed in the bundle — e.g. grep the unpacked asar (or run
   `npx asar extract release/win-unpacked/resources/app.asar /tmp/asar-check` and grep) for the
   string `"Absolute project root (cwd)"` to confirm `absoluteCwdLine` is present in the built
   output, not just in source. Don't rely on `npm test`/`tsc` alone for this round — those
   already passed before D66 was merged and wouldn't have caught a stale-build problem.
4. No source changes are expected. If step 3 somehow fails (string not found in the built
   bundle), that's a real bug worth flagging back rather than fixing blind — stop and report
   instead of guessing at a source change.

## Acceptance
Rebuilt app exists, asar timestamp postdates `33cd025`, and the absolute-cwd string is
confirmed present in the built bundle. Create `D67_done.txt` with the asar timestamp and the
grep result as evidence. No commit needed unless you find and fix a real bug in step 4.
