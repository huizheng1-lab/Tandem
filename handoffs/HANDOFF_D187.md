# Handoff D187 (stop relay-state amplification, recover the 2.05 GB live state fail-closed, and finish D186's missing safety regressions)

## Critical live finding

D186 is not approved. Independent review found that the live relay state is now:

- path: `.git\tandem-relay\state.json`
- size: **2,055,230,520 bytes**
- last write: `2026-07-23T14:11:10Z`
- ordinary `Get-Content -Raw` fails with `System.OutOfMemoryException`

The bounded prefix still shows the required W0027 hard gate:

- `phase=paused`
- `pausedFromPhase=passive-testing`
- `pauseOrigin=machine`
- `pauseReasonCode=candidate-failure`
- `candidateCommit=83421bbc0cd5a8dd2832f194b66e8bf8e9d72eb1`

The file tail contains the same persisted Vitest failure evidence, but with extreme
recursive mojibake expansion. It is no longer a safely operable state file.

There is strong source-level cause evidence:

- `scripts/reciprocal-relay.ps1:173` reads JSON with
  `Get-Content -Raw` and no explicit encoding.
- `Save-State` writes UTF-8 without BOM at lines 381-386.
- even read-only `Status` unconditionally calls `Save-State` at lines 1498-1501.
- D185/D186 persist Unicode Vitest output in `passiveFailure`.

On Windows PowerShell 5.1, repeatedly reading UTF-8-without-BOM through an implicit
legacy encoding and rewriting UTF-8 corrupts non-ASCII output and expands it on every
Status poll. The existing
`.git\tandem-relay\state.corrupt-20260720-204956.json` is also 2,178,833,604 bytes,
so this is a recurrent structural state-persistence defect, not a one-off.

## Corrective work

### 1. Make state persistence byte-stable and read-only Status truly read-only

- Use one explicit, strict UTF-8 encoding for every relay JSON read and write.
- `Status` must not call `Save-State`, change `updatedAt`, rewrite refs, or otherwise
  mutate durable state.
- If schema migration is needed, make it explicit, one-time, bounded, and audited;
  do not hide migration writes inside every Status call.
- Keep atomic temp-file replacement, but add a sane maximum state-file size before
  any whole-file read. Oversized or invalid state must fail closed without attempting
  allocation proportional to the file and without resetting/resuming/accepting work.
- Bound all persisted diagnostic evidence by UTF-8 byte count, not only character
  count. Store concise failure identities and summaries; large raw command output
  belongs in a separate bounded evidence artifact referenced by path/hash if needed.
- Ensure every other script that reads/writes this canonical state uses the same
  encoding and size contract.

### 2. Recover the current live state safely and reversibly

Implement and use a reviewed recovery path; do not hand-edit the 2.05 GB file.

- Acquire the canonical relay lock and stop writers before recovery.
- Validate the bounded top-level prefix, relay refs, candidate/stable SHAs, and live
  hard-gate invariants before constructing a compact replacement.
- Preserve the exact W0027 state listed above, including the candidate and its
  candidate-failure classification. Do not Resume, PassiveTest, exonerate, accept,
  deploy, or advance W0027.
- Preserve concise evidence that the candidate test failed while stable passed, but
  do not copy the amplified raw payload back into state.
- Move the oversized original to a timestamped quarantine/backup path; do not delete
  it. Record old/new byte counts and hashes.
- Atomically install the compact state, verify refs and invariants again, then prove
  repeated Status reads are byte-for-byte non-mutating.
- Never run the old 2.05 GB file through `Get-Content -Raw`,
  `ConvertFrom-Json`, or another whole-file allocation during recovery.

### 3. Remove the spoofable "read-only" baseline allowance

`Test-StableBaselineControlAllowed` currently allows an arbitrary `node` command when
its output merely looks like Vitest (`scripts/reciprocal-relay.ps1`, around lines
569-582). A command can mutate live paths and print a fake `FAIL tests/...` line, so
output cannot prove that the command was read-only.

- Remove output-based trust and reject chained commands/metacharacters, absolute live
  relay/admin paths, deployment/lifecycle helpers, and arbitrary interpreters.
- Prefer structured trusted validation kinds/argv over regex approval of raw command
  strings. If raw strings remain for compatibility, accept only a narrowly anchored
  command grammar with no trailing shell operations.
- Rewrite regression fixtures to use a genuinely trusted test command rather than an
  arbitrary `node -e` escape hatch.

### 4. Complete the D186 regressions that were claimed but not implemented

D186 added only a package lifecycle test and no positive environment-retry test.
Add the required coverage:

- Inject package, B-promotion, and B-launch failures independently. For each, prove
  the mutating helper runs only once for the real candidate operation and is never
  replayed as a stable control; verify runtime/process/journal/release sentinels.
- Prove a machine-origin `environment-failure` performs exactly one permitted
  Resume -> PassiveTest transition.
- Prove repeated environmental failures enter backoff and then the hard circuit
  breaker; no extra Resume or PassiveTest occurs while backoff/hard-blocked.
- Retain the existing negative tests for candidate, human, and unknown pauses.
- Prove a spoofing arbitrary `node`/chained command is never baseline-replayed.

## Required state-persistence regressions

- Persist representative Vitest output containing `❯`, `×`, smart punctuation, and
  non-ASCII paths; run Status at least 100 times through Windows PowerShell; assert
  identical state hash, size, bytes, `updatedAt`, and semantic content.
- Repeated mutating saves with the same evidence remain byte-stable and preserve
  exact Unicode.
- Oversized and invalid JSON fixtures fail closed before whole-file allocation.
- Recovery fixture compacts an amplified state, preserves the hard pause/candidate/
  refs, quarantines the original, and is idempotent.
- Persisted diagnostic payload limits are asserted in UTF-8 bytes.

Run the relay, supervisor, dashboard library, approval-flow, candidate-preview, and
new state-recovery focused suites; then `npm run typecheck`, `npm test`, and
`git diff --check`.

## Live/deployment safety

- Preserve unrelated user worktree changes.
- Do not create or approve a W0027 application candidate.
- Do not resume the current W0027 candidate-failure pause.
- Deploy dashboard changes only through the managed deployment script if dashboard
  source changes, then verify source/target hashes.
- Report the exact recovered live state, old/new state-file sizes and hashes,
  quarantine path, repeated-Status byte-stability proof, and unchanged relay refs.

Commit as `D187-<n>:` and create `handoffs/D187_done.txt`.
