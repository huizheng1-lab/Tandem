# Handoff D116 (harden the reciprocal workflow before first autonomous run)

Follows my review of the reciprocal Tandem plan (process/reciprocal/*, scripts/*). The
design's safety engineering is good; these changes close the gaps found before the loop is
allowed to run unattended. Verified current state: worktrees exist at
`C:\Users\huizh\Apps\Tandem Reciprocal\worktrees\copy-a|b`, both branches
(`codex/reciprocal-a|b`) are at f1bae2c (pre-D108) while master is at 6857e2f; both pinned
runtimes are the Jul 13 D107 build; the dashboard exists at the relay root.

## D116-1: fast-forward both reciprocal branches to current master

Both branches are strict ancestors of master (f1bae2c -> 6857e2f), so a pure
fast-forward is legal and required by the relay's own ff-only rule. For each of
`codex/reciprocal-a` and `codex/reciprocal-b`: ff the branch to master's commit (from the
admin repo: `git fetch . master:codex/reciprocal-a` etc., or update via the worktrees -
verify each worktree ends checked out at 6857e2f with a clean status). Update
`refs/tandem-relay/stable` to the same commit. Push both branches to origin. Do NOT do
this if either branch has gained a commit master lacks (re-check first; if diverged, stop
and report instead).

## D116-2: promote both pinned runtimes to the D115 build

The pinned executors run the D107 build, which contains the leader-answers-without-
BuildPlan bug fixed in D108 (a7ce396) - a failure mode that silently wastes autonomous
turns. The current `release/` build (Jul 15 20:36, built from 57d93a8/D115) is a reviewed
build that includes it. With both executors STOPPED (verify no Tandem.exe running from
either runtime dir): replace the contents of `runtimes\executor-a` and `runtimes\executor-b`
with the current `release\win-unpacked` contents. Preserve each executor's isolated
TANDEM_HOME/state/user-data untouched. Note in the marker which build SHA the runtimes now
carry. (README's canary rule is for autonomously-produced builds; both may be promoted here
since D115 went through the normal reviewed D-round path.)

## D116-3: add a live-smoke gate to VALIDATE for model-facing candidates

Edit `process/reciprocal/PROTOCOL.md` step 3 (`VALIDATE`): when the candidate diff touches
`src/agents/`, `src/orchestrator/`, `src/session/compaction`/prompt files, or
`src/providers/`, the validator must ALSO run one cheap real-model smoke before accepting -
use the existing pattern (`scripts/live-minimax-m3.ts` or a minimal equivalent invoking
`createLiveAgents().plan()` on a trivial request with the m3 worker creds from the
executor's own isolated .env) and require a schema-valid result, not just exit-0. Static
checks alone have repeatedly passed on live-dead code in this project (D41-D47, D105,
D109-D111) - two executors sharing the same static suite is correlated blindness, this
gate is the fix. Keep it cheap: one call, minimax-m3, only when those paths are touched.
Document the expected cost (~fractions of a cent) in the protocol so executors don't skip
it as "expensive."

## D116-4: disable the [AUTO] self-selected lane initially

Edit `process/reciprocal/PROTOCOL.md` step 4 and `SHARED_DIRECTION_TEMPLATE.md` guardrails
(plus the live control file `C:\Users\huizh\Apps\Tandem Reciprocal\control\SHARED_DIRECTION.md`
- use the mutex-protected script or careful direct edit of the guardrails section only):
until a human re-enables it, executors must NOT self-select `[AUTO]` improvements; if no
human wishlist item is QUEUED, use `Pause` with reason "no queued human item". Add a
guardrail line saying exactly that, marked as removable by the human once a few batches
have been reviewed. Rationale: standing project priority is minimizing expensive-model
consumption; an hourly self-directed improvement loop works against it until proven.

## D116-5: document the master-reconciliation policy

Add a section to `process/reciprocal/README.md` (or PROTOCOL.md): master remains the trunk.
(a) Before starting a relay session, if the reciprocal branches are strict ancestors of
master, fast-forward them to master (as in D116-1). (b) After a reviewed batch, PAUSE the
relay, merge the stable ref into master through the normal human-supervised flow (a merge
commit on master is fine - the ff-only rule governs the relay branches, not master), then
ff both branches to the new master and resume. (c) Never run D-round master work and relay
turns concurrently on overlapping files; if a D-round lands on master mid-batch, finish the
batch, then reconcile. This closes the drift gap the current docs don't address.

## D116-6: dashboard improvement - drift and staleness visibility

The dashboard (relay root `dashboard/`, served on 127.0.0.1:4782) is well-built (mutex-
respecting wishlist writes, token-gated mutations, audit log, instruction-generator-only
recovery). One gap matters operationally: nothing surfaces STALENESS. Add to the status
payload and UI: (1) each pinned runtime's build identity (e.g. read a small
`BUILD_INFO.json` you drop into each runtime dir during D116-2 promotion, containing the
source SHA) and how it compares to current master; (2) each reciprocal branch's
ahead/behind counts vs master (`git rev-list --left-right --count`); (3) a visible warning
chip when runtimes or branches lag master. This makes the "time to promote/reconcile"
decision visible instead of requiring someone to remember. Keep it read-only telemetry -
no new mutation endpoints.

## W0003 note (do not implement, just re-scope)

The queued wishlist item W0003 (iPhone remote control via Telegram) is large, security-
sensitive, and multi-turn - exactly what PROTOCOL.md says must NOT be attempted as an
autonomous turn. Edit the item (mutex script, `Requeue`-style note or a text amendment) to
mark it "requires human-reviewed handoff design first - not eligible for autonomous
implementation," so an executor doesn't claim it on the first working turn.

## Acceptance

tsc + `npm test` green in the admin repo (protocol/doc/script changes shouldn't affect
them; run as sanity). For D116-1/2: paste `git log -1 --oneline` per branch, worktree
status, the stable ref value, and the runtime BUILD_INFO contents. For D116-3/4/5: the
edited protocol/README/control-file sections quoted in the marker. For D116-6: dashboard
loads and shows the new drift fields with both runtimes reporting the promoted build
(screenshot or pasted JSON of the status payload is fine). Commit `D116-<n>:` per logical
piece (docs+scripts in the admin repo; control-file edit is outside git, just describe it),
push master and both branches, create `handoffs/D116_done.txt`.
