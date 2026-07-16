# Handoff D101 (two real bugs found live: path-quoting in verification commands, takeover safety-net gap)

Found while re-testing the real Age of Empire mouse-control fix through the D97-D100 build. The
fix itself is genuinely good (real code changes, real new tests, real UX improvements — not in
question). Two separate, real problems surfaced in the takeover's `verificationResults`, both
worth fixing.

## D101-1: verification commands with unquoted absolute paths break under D97's real execution

Confirmed live, real data. The user's project directory is
`C:\Users\huizh\tmp_test_data\Age of Empire test build` — note the spaces. Three of four
verification commands in the real TakeoverReport failed with:
```
Error: Cannot find module 'C:\Users\huizh\tmp_test_data\Age'
```
Root cause confirmed by reading `src/tools/shell.ts`'s `bashTool` (~line 114):
`execa(command, { cwd: ctx.cwd, shell: true, ... })` — passes the ENTIRE command as one raw
string to the OS shell (cmd.exe on Windows), which tokenizes on whitespace. The failing commands
looked like:
```
node C:\Users\huizh\tmp_test_data\Age of Empire test build\node_modules\.bin\vitest.cmd run ...
```
— the absolute path is embedded UNQUOTED directly in the command string (per
`absoluteCwdLine()` in `src/agents/live.ts`, which instructs every leader/worker to prefix paths
with the absolute cwd, but says nothing about quoting for shell safety). cmd.exe splits on the
space in "Age of", so `node` receives `C:\...\Age` as its module argument and everything after as
separate garbage tokens — exactly the observed error. The 4th command in the same report
(`node -e "...fs.readFileSync('...Age of Empire...')..."`) correctly PASSED, because that path
lives inside a JS string literal argument to `-e`, never appearing as a bare shell token.

This is NOT project-specific — ANY project whose folder path contains a space (extremely common:
"My Documents", "Program Files", any folder a user names with words) will hit this for every
orchestrator-run verification command that embeds the absolute path as a bare token. This is a
real, systemic gap in D97's new authoritative-verification feature, invisible before D97 because
only the model's own SELF-REPORTED "I ran it" mattered, not real execution.

**Fix direction**: the absolute-path instruction (`absoluteCwdLine`, shared across leader/worker
prompts) should tell models to QUOTE any absolute path argument that could contain spaces when
constructing shell commands (e.g. wrap in double quotes on Windows, standard practice). This is
a prompt-level fix, not a `bashTool` fix — `bashTool` correctly executes whatever command string
it's given; the STRING itself needs to be shell-safe. Verify the exact wording that reliably
gets models to quote paths (don't assume; this project's history is full of prompt-wording
subtleties that didn't work as expected on the first guess — test live with a real project path
containing a space). Do NOT attempt to auto-quote/rewrite arbitrary shell command strings inside
`bashTool` itself — that's a much harder, riskier problem (arbitrary shell syntax) than fixing
the prompt that generates them in the first place.

## D101-2: takeover has no safety net when authoritative verification finds real failures

Confirmed by reading `src/orchestrator/machine.ts`'s `runTakeover` (~line 394-410): the
post-attach validation call passes `enforceCompleteVerification: !authoritative.ran` — meaning
whenever the verification runner actually executed (regardless of what it found), the "marked
complete with failing verification" check is SKIPPED entirely. This was intentional for the
WORKER path (D97's whole point: let a complete-claiming report with real failures flow to
REVIEW instead of blind-rejecting) — but **takeover has no review step after it**; its result
goes straight to DONE. So a takeover that claims `status: "complete"` with genuinely failing
ground-truth verification results currently sails through with zero enforcement — the exact
scenario observed live tonight (3/4 real verification commands failed, report still said
`status: "complete"`, run ended `DONE`/`takeover done`). In THIS case the underlying work was
actually fine (the leader's own narrative explains the path issue and shows it verified via
adapted commands) — but the MECHANISM that let it through would equally let through a genuinely
broken takeover with a false "complete" claim, since nothing downstream double-checks it.

**Fix direction**: for the takeover path specifically, when `authoritative.ran` is true AND real
failures are present in the attached results, don't silently allow `status: "complete"` through.
Options, pick the simplest that fits: (a) downgrade the report's status to something honest
(e.g. `"blocked"`) when authoritative results show failures but the model claimed complete, with
a clear note in the takeover's user-facing summary; (b) keep `enforceCompleteVerification` off
for the initial parse but add a SEPARATE takeover-specific check after attach that surfaces (at
minimum, as a prominent notice/warning event) when a "complete" claim disagrees with real
results, so the user isn't silently told a takeover succeeded when it didn't fully verify. Don't
revert to the old hard-reject-and-retry behavior for takeover (that reintroduces D96/D90-style
retry-burn) — the goal is surfacing the disagreement, not blocking completion outright, since
takeover is already the last-resort escalation and endless-retry isn't available there anyway.

## Acceptance

tsc + `npm test` green. D101-1: a regression test constructing a verification command with an
embedded absolute path containing a space, confirming (after the prompt-wording fix) that
freshly-generated commands from a live model call quote it correctly — this needs a REAL live
call to a real project path with a space to confirm the prompt change actually works, not just a
static string check (mirror this project's established discipline: prompt-wording fixes have
failed silently before, e.g. the D44/D47 preamble saga — verify live, don't assume wording
works). D101-2: a regression test with a scripted takeover agent that claims `status: "complete"`
while the injected verification runner reports a real failure, confirming the run does NOT
silently present this as a clean success (per whichever fix direction is chosen). Live
verification: re-run the exact real scenario from tonight (or an equivalent project with a
space in its path) and confirm all verification commands the orchestrator runs now succeed
(or, if D101-2's status-downgrade approach is chosen, confirm a genuinely-failing takeover no
longer reports as complete). Commit `D101-<n>:`, create `handoffs/D101_done.txt`.
