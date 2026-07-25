# Handoff D194 (promotion-operation journal is never finalized after success — every subsequent candidate's B promotion deterministically fails closed; efb3b06 is blocked on D190's leftover record)

## Live incident (evidence in state — don't re-derive)

W0027 step 3/3 candidate `efb3b06a37390fcf191eb9f07f4fa479d49faee7` finally passed
all mechanical checks (D193's timeout fix worked) and reached B-runtime promotion,
which failed:

```
Existing executor-b promotion operation targets a different package; inspect
C:\Users\huizh\Apps\Tandem Reciprocal\state\promotion-operations\executor-b.json
```

The gate handled it correctly (mutating lifecycle op → baseline replay skipped →
`environment-failure`, candidate left pending). But the failure is deterministic,
so the supervisor's bounded retries will just burn attempts into the circuit
breaker — this needs the code fix, not retries.

The leftover record is the **previous** candidate's promotion
(`sourceSha 83421bb`, package `047AD955...`, `stage: "target-verified"`, updated
17:10Z — the successful D190 acceptance flow). `promote-reciprocal-runtime.ps1`
lines ~140-145 throw on ANY existing operation record whose sha/package differ,
with no regard for whether that operation already completed successfully, and
nothing in the success path ever finalizes/clears the record. Net effect: the
first successful promotion permanently blocks all future promotions for that role
until a human deletes the file. (Same disease class as the recovery journal D192-2
just fixed — reset/finalize per candidate — but in the promotion-operation
journal.)

## Fix

1. **Finalize on success**: when a promotion operation reaches its terminal
   success stage (target verified), finalize the record — archive it (e.g. append
   to a bounded history file or rename with a timestamp) or mark it
   `stage: "completed"` — such that a NEW candidate's promotion may proceed by
   starting a fresh operation.
2. **Keep fail-closed for genuinely in-flight records**: a record in any
   non-terminal stage (staging, backup, mid-swap) with a different package must
   still refuse exactly as today — that's real crash-recovery protection. Only
   verifiably-completed prior operations may be superseded. Decide and document
   which stages count as terminal-success (the record's own targetProof/BUILD_INFO
   consistency check is a reasonable success verification).
3. **Clear the live blocker** per the same rule: verify the existing executor-b
   record's target proof matches the currently-installed executor-b runtime
   (83421bb / 047AD955... — i.e., that operation genuinely completed), finalize it
   through the new mechanism (no bare hand-deletion — the finalize path should do
   it), and let the pending `efb3b06` promotion re-run.
4. **Regressions**: (a) completed prior operation + new candidate → promotion
   proceeds with a fresh operation record; (b) in-flight prior operation with a
   different package → still fails closed; (c) same-package resume behavior
   unchanged; (d) the finalize path is idempotent.

## After the fix

Resume/re-run the passive gate for `efb3b06` (reference this handoff in the
`-Summary`). If everything is green through packaging, promotion, and B launch
verification: the relay must stop at `a-upgrade-pending` — the human A-runtime
promotion gate. Do NOT cross it autonomously.

## Constraints

- Do not weaken the package-identity/attestation checks themselves (D184) — the
  fix is lifecycle completion, not looser matching.
- No bare deletion of the live record outside the new audited finalize path.
- Do not cross the a-upgrade-pending human gate.

## Acceptance

`handoffs/D194_done.txt`: the terminal-stage definition, finalize mechanism,
regression names, and live proof: the finalized old record (archived form), the
fresh efb3b06 operation record, and the relay reaching `a-upgrade-pending` (or a
genuinely-evidenced failure elsewhere). tsc + `npm test` green. Commit
`D194-<n>:`. Create `handoffs/D194_done.txt`.
