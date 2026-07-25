# Handoff D196 (drastically simplify the reciprocal system into a single-orchestrator loop — a replacement for the multi-actor coordination layer, per explicit human direction 2026-07-23)

## Why (human decision, not open for re-litigation)

Ten stalls in one day, none of them the loop's logic: every incident traced to the
coordination surface — six independent actors (Executor A app + cron, Executor B
app, per-action relay CLI, continuation supervisor, dashboard server, human
console) passing a baton through shared mutable files across ~10 phase
transitions per cycle, on a substrate (PowerShell 5.1/Windows) that generates
spurious anomalies, with fail-closed checks multiplying every anomaly into a
pause. The human has directed a drastic simplification. This is infrastructure
(D-round) work on the reciprocal layer itself, implemented directly on master
with normal review — NOT a Tandem wishlist item (W0028 was briefly queued by
mistake and removed).

## Target design (human-specified flow — implement this, not an approximation)

One **orchestrator** process, invoked by cron from the admin repo, owns an entire
improvement cycle sequentially. It is the ONLY writer of relay state and the ONLY
invoker of every mechanical step (always current admin-repo code — version skew
becomes structurally impossible).

Cycle:
1. Claim the highest-priority queued wishlist item. If none: do nothing until the
   next cron tick.
2. A implements/modifies B's copy per the item. B does nothing while A works.
3. A tests the modification. If satisfied → approve (A's judgment is final; there
   is NO human confirmation gate anywhere in the cycle — the human explicitly
   removed the runtime-promotion approval).
4. If not satisfied: feed the full failure output back to A and retry the same
   item. After **two consecutive failed rounds**: write a human-readable failure
   report file and set state `failed-paused`. That is the only in-cycle human
   touchpoint.
5. On success: build B's runtime and start the B instance.
6. B runs one **mechanical** rebuild-A script (no agent): stop/kill the A
   instance, install the same accepted version as A's runtime, start the new A.
7. A stops the B instance, checks the wishlist, continues or idles.

Human touchpoints, complete list: add wishlist items; a pause control; read
failure reports; and the existing post-hoc **feature review-rejection loop**
(human rejection re-queues the item with feedback — keep that mechanism intact,
it repeatedly caught what self-tests missed).

## Delete (replacement, not layering — the old actors must be gone at the end)

- Continuation supervisor (the orchestrator owns retries).
- Stable-baseline discrimination/classification machinery (D185–D188): the
  retry-with-feedback loop replaces it — A judges environmental-vs-real from the
  failure output itself.
- Promotion-operation and runtime-recovery journals → one plain sequential
  operation log.
- schemaVersion migration boundary (unneeded once only the admin-repo
  orchestrator can act on state).
- All agentic behavior for B (B exists only to run the rebuild-A script during
  the swap window).
- Dashboard mutation paths — dashboard becomes read-only status + pause +
  failure reports. (This supersedes HANDOFF_D195's dashboard-verification fix;
  fold it in or skip it — do not fix soon-to-be-deleted code paths separately.)
- The multi-phase gate taxonomy: state collapses to approximately
  `idle / improving / swapping / failed-paused`.

## Keep (earned its keep)

- git stable/candidate refs.
- One small state JSON, exactly one writer, hardened strict-UTF-8 I/O with size
  caps (D187's helpers).
- One runtime integrity/hash check before any swap.
- The wishlist file, rejection-requeue flow, and cron scheduling.
- Crash recovery: a cycle interrupted mid-flight (reboot, kill) must be
  resumable or cleanly restartable by the next cron tick from the small state
  file — but via the ONE orchestrator, not a second recovery actor.

## Cutover

- The relay is currently parked at `a-upgrade-pending` (accepted stable
  `efb3b06`, B runtime already promoted+verified at that version, A runtime
  stale). The new orchestrator's first live cycle — or an explicit cutover step —
  must bring A's runtime to the current accepted stable, replacing the parked
  legacy gate rather than completing it through the old machinery.
- Migrate/replace PROTOCOL.md and executor templates to describe only the new
  design. Old phases/actions should hard-fail with a pointer to the new
  orchestrator, not half-work.
- W0023 (Telegram approval step) and the rejection loop continue under the new
  system through the same wishlist file.

## Acceptance

`handoffs/D196_done.txt` with:
- The new orchestrator's design summary: state phases, the single entry point,
  what runs at each step, and the complete list of deleted components (verify
  none of them can still execute — removed or hard-disabled, not dormant).
- Regression coverage for: happy-path full cycle; first-failure retry with
  failure feedback visibly passed to round two; two-strike failure report +
  `failed-paused`; crash-mid-cycle resumability; wishlist-empty idle; rejection
  re-queue surviving the redesign.
- **Live proof, end-to-end**: a real wishlist item driven through a complete live
  cycle — A implements, tests pass, B runtime built and started, B mechanically
  rebuilds A, new A instance running at the accepted version, B stopped — with
  timestamps and the state file's transitions. Plus the two-strike path proven
  live or in a fixture (fixture acceptable for the failure path only).
- A moving-parts count: old actors/files vs new (the human's bar is "fewer than
  half the current moving parts").
- tsc + `npm test` green. Commits `D196-<n>:`. Create `handoffs/D196_done.txt`.
