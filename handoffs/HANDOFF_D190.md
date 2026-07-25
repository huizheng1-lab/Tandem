# Handoff D190 (two proven live defects: the D185 baseline control wipes copy-a's node_modules through its junction, and the executor runs a pre-D185 relay script from the candidate checkout — together they just produced a third false blame of candidate 83421bb)

Complementary to D189 (which is test/proof hardening only). This round contains the
live-incident fixes and the live recovery. If sequencing matters, land this one's
Part 1 fix before anything re-runs a baseline control, because every control run
currently destroys the workspace's dependencies.

## Live incident (both root causes proven by direct experiment — don't re-derive)

At the 16:07Z executor cron tick, PassiveTest for W0027 candidate
`83421bbc0cd5a8dd2832f194b66e8bf8e9d72eb1` failed all three mechanical checks with
`'tsc' / 'vitest' / 'tsup' is not recognized` and the relay paused as
`pauseReasonCode: "candidate-failure"` with **`passiveFailure: null`** — no baseline
discrimination, no evidence record, despite D185–D188 all being merged. The
candidate is innocent (third false blame). Two separate defects combined:

### Defect 1: the stable-baseline control deletes copy-a's node_modules through the junction

`Invoke-StableBaselineControl` (`scripts/reciprocal-relay.ps1`, ~line 697) creates an
NTFS **junction** from the temp baseline worktree's `node_modules` to the live
workspace's `node_modules`, then cleans up in its `finally` with
`git worktree remove --force $baselineRoot`.

**Proven by isolated experiment** (real git repo, detached worktree, junction to a
target dir containing a sentinel file): `git worktree remove --force` deletes
**through** the junction — the target directory survives but its contents are
emptied (`children: 1 → 0`). The `Remove-Item -Recurse` fallback was also tested
and is NOT guilty (it removes only the link, target intact). Live timestamps match
exactly: the D185 live-proof baseline run finished ~13:25:54Z on Jul 23 and
copy-a's `node_modules` was emptied at 13:25:57Z (dir mtime), which is what broke
the next PassiveTest three hours later.

So every baseline control run **destroys the live workspace's dependencies** — a
direct violation of D185/D186's "isolated worktree, no live mutation" constraint.
The D186/D188 regression fixtures never caught it because they fake vitest with
node scripts and never have a real `node_modules` to junction.

### Defect 2: the executor runs the relay script from the candidate checkout — 4 rounds stale

The scheduled Executor A invocation runs `scripts/reciprocal-relay.ps1` from its own
workspace `copy-a`, which is checked out at the **candidate commit** `83421bb`
(created Jul 22, before D185 landed). Verified:
`git show 83421bb:scripts/reciprocal-relay.ps1` contains **zero** occurrences of
`passiveFailure`, `stable-baseline`, or `Read-Utf8JsonFile`, and its old pause path
produces exactly the summary text and evidence-free state observed live (old-style
`candidate-failure` with no record; the `passiveFailure: null` in state is simply
the inert leftover from the prior Resume, preserved by the old script).

Consequences: all D185–D188 gate protections (baseline discrimination, evidence
records, lifecycle-failure classification, strict UTF-8 I/O, size caps, hardened
command grammar, read-only Status) are silently absent whenever the gate runs from
the copy-a checkout. **The 2GB encoding-amplification bug is still live in that
script version** — it only hasn't re-triggered because the current state file is
pure ASCII. Any non-ASCII entering `lastSummary` before this is fixed re-arms the
amplification.

## Fix — both parts required

### Part 1: make baseline-control cleanup junction-safe

Before removing the temp baseline worktree, explicitly unlink the `node_modules`
junction itself (a non-recursive link removal, e.g. `[IO.Directory]::Delete($path,
$false)` or `cmd /c rmdir` on the junction path), and only then run
`git worktree remove --force`. Alternatively drop the junction approach for a safer
equivalent — but keep the control run fast; a full `npm ci` per control run is a
fallback, not the default.

Regression (mandatory, must use a REAL junction): baseline-control fixture where
the workspace has a real `node_modules` directory containing a sentinel file;
assert after the control run — success path, failure path, and the
worktree-remove-fails → `Remove-Item` fallback path — that the sentinel and the
workspace `node_modules` contents are fully intact.

### Part 2: the mechanical gate must never run a stale relay from the candidate checkout

The relay/gate scripts that execute PassiveTest, the baseline control, packaging,
and state I/O must always be the **admin repo's current (master) versions** — never
the copy under test. Decide the mechanism (any combination; pick and justify):

- point the executor invocation/prompt (TANDEM.md injection, schedule prompt) at
  the admin repo's `scripts/reciprocal-relay.ps1` explicitly, and/or
- have the relay self-check: if invoked from a workspace checkout whose script
  version/schema is older than the state file's expectations, re-exec the admin
  repo copy or refuse with a distinct error, and/or
- route all mechanical phases through the continuation supervisor, which already
  uses `$PSScriptRoot` (admin repo).

Add a regression proving a PassiveTest driven "from copy-a" (fixture equivalent)
executes the current gate logic (evidence record present, discrimination
performed), not the checkout's stale script. Update PROTOCOL.md so this is a
stated invariant.

### Part 3: unblock the live state

1. Restore copy-a's dependencies (`npm ci` in copy-a, per the D185 done-notes
   precedent — stop any Executor B process holding Electron files if needed).
2. Clear the current bogus pause and give `83421bb` a fair PassiveTest under the
   **new** gate (admin-repo scripts, with Part 1's fix in place). Expected: it
   passes (the earlier 5010ms `reciprocal-direction` timeout was already shown to
   be a load flake — the test passes standalone in ~2-3s), or it fails on
   something real, which then pauses with a full evidence record as designed.

## Constraints

- Do not weaken the gate checks or the D186/D188 classification rules while
  rerouting which script runs them.
- The junction fix must not leave orphaned temp worktrees or junctions on any
  failure path — cleanup must stay complete.
- Do not advance/accept `83421bb` without a genuinely green passive run under the
  new gate. The current pause is wrong (evidence-free, environmental origin), but
  exoneration must come from a real green run, not from this diagnosis.
- Leave the D187 quarantine file and the archived corrupt state untouched.
- D189's constraints forbid touching live state in D189's own scope; the live
  recovery belongs here in D190 Part 3 and should reference this handoff in the
  relay `-Summary`.

## Acceptance

`handoffs/D190_done.txt`: explain the junction-safe cleanup and the chosen
stale-script prevention mechanism; include the real-junction regression results and
the copy-a-driven gate regression; live proof showing (a) copy-a `node_modules`
restored, (b) a full PassiveTest cycle for `83421bb` run through the current gate
with a real evidence record in state, and (c) copy-a `node_modules` still intact
AFTER a baseline-control-exercising run (prove the wipe is gone live, not just in
tests). tsc + `npm test` green. Commit `D190-<n>:`. Create
`handoffs/D190_done.txt`.
