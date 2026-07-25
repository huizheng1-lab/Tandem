# Handoff D129 (URGENT: executor sandbox cannot complete Start/Pause/Complete - reciprocal loop is structurally stuck)

The relay is currently PAUSED (I paused it manually, from outside the executor sandbox,
after finding it stuck in a retry/takeover loop that could never succeed). Do not resume
until this is understood and fixed - resuming as-is will just repeat the same failure and
burn tokens.

## What happened (full evidence in the real session log - read it first)

`C:\Users\huizh\Apps\Tandem Reciprocal\state\executor-a\sessions\d029c3483314\89f5da01-9c80-43cb-92db-92801797b964.jsonl`
(tail of file, turn 5, most recent events)

Sequence: (1) a scheduled turn read `SHARED_DIRECTION.md`, hit a transient tool error, gave
up prematurely (leader's own review correctly flagged this as wrong - should have
retried). (2) A takeover attempt correctly identified the assignment (W0010 Step 1) but
reported, verbatim: `"Start failed because .tandem/shared-control is a junction to
C:\Users\huizh\Apps\Tandem Reciprocal\control, outside the writable sandbox"` and
`"Pause was attempted but could not write C:\Users\huizh\Apps\HZ code\.git\tandem-relay\
state.json"`. Also reported vitest/esbuild directory traversal denied. The turn ended
honestly as `blocked`/DONE with "The repository remains completely unchanged and clean" -
no corruption, no false success, but also zero real progress across the whole cycle, and
real tokens spent on every failed retry.

## Root cause candidates - determine which one actually occurred, then fix it

**(C) - PRIMARY HYPOTHESIS, check this first: Codex CLI's own OS-level sandbox.** The
executors' leader has been codex/cli (gpt-5.6-sol) since D124, and Tandem ALWAYS invokes
codex with `--sandbox workspace-write` (verified: `codexSandboxFor()` in
`src/agents/codex-cli/exec.ts` lines 33-35 returns "workspace-write" for every
permissionMode including yolo; "danger-full-access" is never used). Codex's
workspace-write sandbox OS-enforces that the subprocess (including any shell commands the
model runs INSIDE codex) can only write within its workspace = the target worktree. Both
failing paths are OUTSIDE it: the `.tandem/shared-control` junction resolves to the relay
control dir, and the relay state file lives in the ADMIN repo's `.git/tandem-relay/` (a
linked worktree's `.git` is just a pointer file - the common git dir is in the admin
repo). The takeover report's exact phrasing - "outside the writable sandbox",
"out-of-workspace control locations" - is Codex sandbox terminology, not protection.ts
wording (protection.ts throws "Tandem will not modify its own installation..."). The
esbuild "denied directory traversal" during in-turn vitest fits the same sandbox. Why
this was invisible until now: D124's executor-context proof was a READ-ONLY leader
question (no writes), and D122's one-click smoke ran when the executors' leader was still
minimax (SDK path, no Codex sandbox involved). The first genuinely write-bearing codex
turn is exactly where it broke.

**Fix direction for (C)**: give the sandboxed codex process the MINIMUM additional
writable roots it needs - Codex CLI supports extending workspace-write with extra
writable directories via its config surface (check codex-cli 0.144.2's actual mechanism:
`-c sandbox_workspace_write.writable_roots=[...]` or equivalent - verify against the real
CLI with a live probe, do not assume the config key). Scope it to exactly: the relay
control directory (`C:\Users\huizh\Apps\Tandem Reciprocal\control`) and the relay state
dir (`C:\Users\huizh\Apps\HZ code\.git\tandem-relay`) - NOT the whole admin repo (least
privilege; protection.ts continues to guard Tandem-tool-level writes independently).
Thread it through Tandem's codex exec wrapper only for the reciprocal/automation context
(an env-var or config-driven opt-in, e.g. set by the executor launcher - normal codex
usage must keep the plain workspace-write sandbox). Alternative if writable-roots proves
unsupported/flaky: move relay-state transitions out of the sandboxed model entirely (the
unsandboxed Tandem service/automation layer performs Start/Complete/Pause around the
turn) - a bigger change; prefer the writable-roots route if it verifies cleanly. Also
verify the in-turn vitest/esbuild denial is resolved by the same change (worktree
node_modules should already be inside the workspace - if that failure persists, diagnose
it separately rather than assuming).

Secondary candidates - only if the log disproves (C); I originally traced
`src/tools/protection.ts`'s `isProtectedPath()`/`assertSafeWritePath()`, which treats any
path inside `TANDEM_PROTECTED_ROOTS` (set by `start-reciprocal-tandem.ps1` to include the
admin repo) as off-limits to Tandem's own file write/edit TOOLS. Both failing paths
resolve inside that protected admin-repo root too, so these remain possible:

**(A) The model tried to mutate these files directly** with Tandem's own write/edit tool
instead of running the protocol-prescribed PowerShell commands (`reciprocal-relay.ps1
-Action Start/Pause`, `reciprocal-direction.ps1 -Action Start`). If so, this is correctly
blocked by design - `protection.ts` is working as intended. The fix is prompt/protocol
clarity: make it unmistakable (in the leader/worker system prompts used for reciprocal
work, and/or in PROTOCOL.md itself) that ALL relay state mutations happen ONLY via the
named PowerShell scripts run through the shell/bash tool - never via direct file
read/write/edit tool calls on `.tandem/shared-control/*` or the relay state path. Consider
whether the model even understood "Start" in step 5 of PROTOCOL.md as "run this exact
command" vs. "update this file's status field" - reword if ambiguous.

**(B) The model correctly invoked the prescribed PowerShell script as a subprocess, and
the subprocess itself failed to write** (a real infra bug, not a model-behavior one).
Since a spawned subprocess does its own OS-level file I/O and is NOT gated by
`protection.ts` (that layer only wraps Tandem's own internal file-write/edit tool calls,
confirmed by reading `assertSafeBash()` - it only pattern-matches specific `.tandem` path
strings in the command text, it does not sandbox what a spawned process can actually touch
on disk), a genuine write failure here would have to come from somewhere else: an actual
Windows ACL/permission difference on the junction or the admin repo's `.git` directory
when accessed from the executor's process identity, a locked file, or some other real OS-
level restriction. If this is what happened, the fix is at the OS/launcher level (junction
permissions, `.git/tandem-relay` directory ACLs, or the executor's process token), not in
`protection.ts` or the prompts.

Determine which happened by reading the exact tool-call sequence (not just summaries) in
the session log, and possibly by re-running the exact failing command directly (as the
executor would) to see whether it fails the same way outside of a full agent turn.

## Also investigate: vitest/esbuild directory traversal denial

Reported separately in the same blocked turn - possibly the same root cause (protected-
root overlap with shared/symlinked `node_modules`), possibly unrelated (a real Windows
permission gap on the worktree). Read the actual error, not just the summary line, and
fix or explain.

## Constraints

- Do not weaken or bypass `protection.ts`'s self-protection guarantees to work around this
  - the admin repo genuinely must stay protected from a misbehaving executor's arbitrary
    file edits. The fix must distinguish "prescribed relay-script writes" (which the
    protocol explicitly sanctions - see PROTOCOL.md's safety boundaries: "Never modify...
    the admin worktree... by any route other than the relay command and the current
    target worktree") from "arbitrary direct writes" (which must stay blocked).
- Do not have the relay auto-resume as part of this round - leave it paused; the human
  will resume once satisfied.

## Acceptance

Root cause identified with evidence (exact tool call, not summary) and explained in the
marker: (C) the Codex workspace-write sandbox (primary hypothesis - confirm by reproducing
the write denial with a direct `codex exec --sandbox workspace-write` probe attempting the
exact failing write, then confirm the writable-roots fix makes the same probe succeed),
or (A) a model bypassing the script, or (B) a genuine subprocess/OS write failure. Fix
applied matching whichever it was. Live proof required: resume-equivalent
test that actually runs a real turn through Start (or the prescribed script) and Pause/
Complete against the REAL executor sandbox (not a simulated/local run outside it - this
exact class of failure was invisible during D126/D127's manual acceptance demos, so those
demos are not sufficient evidence here; something about the actual scheduled/sandboxed
execution path differs and must be exercised for real). Paste the real command/tool-call
output showing Start and Pause (or Complete) both succeed from inside the executor
context. tsc + `npm test` green if code changed. Leave the relay PAUSED when done -
report readiness to resume, do not resume it yourself. Commit `D129-<n>:` for any
admin-repo fix; describe prompt/protocol wording changes fully in the marker. Create
`handoffs/D129_done.txt`.
