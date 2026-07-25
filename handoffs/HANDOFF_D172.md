# Handoff D172 (Add the missing end-to-end approval-flow regression for D171)

## Review verdict

D171 successfully recovered the live `ead38ad` A-upgrade gate:

- relay is now `idle` at stable `ead38ad2692d2a5641ce3cdaed684ab75ebf2db1`;
- both pinned runtime BUILD_INFO files match that SHA;
- no runtime copy was performed during recovery;
- W0026 remains `DONE` and W0027 remains `QUEUED`.

The implementation is **not approved yet**. D171 explicitly required an
integration-level approval-flow regression, but only added pure helper assertions in
`dashboard/lib.nodecheck.mjs`. Those assertions never execute
`waitForApprovalBoundary()`, `resumeApprovalPause()`, `relayControl()`, or the real
`scripts/reciprocal-relay.ps1` state transition.

This gap matters because D169 also had passing helper-level coverage while the real
approval sequence still failed. Do not change the now-working live recovery state or
implement W0027. This correction is test-harness/proof work only, unless that proof
finds a real defect.

## Exact missing proof

Current helper coverage proves only that:

- `approvalBoundaryPlan({ phase: "a-upgrade-pending", activeRole: null })` returns a
  plan; and
- `approvalCompletionRelayAction("a-upgrade-pending")` returns
  `CompleteAUpgrade` with workspace `a`.

It does **not** prove that a real dashboard approval invocation:

1. avoids invoking `Pause` when the relay is already inactive at
   `a-upgrade-pending`;
2. routes the terminal command to passive copy-a / `codex/reciprocal-a` with Role A
   and `-Force`;
3. receives the real `A_UPGRADE_COMPLETED` relay result and leaves durable state
   `idle`; or
4. avoids a second runtime promotion while recovering the exact previously stranded
   paused state.

## Required work

### 1. Add a real isolated approval-flow integration test

Add a terminating automated test/harness that invokes the dashboard approval
orchestration path, not just exported decision helpers. It may use an isolated temporary
relay/worktree fixture and command doubles for process stop/start/runtime-copy mechanics
so it never touches the live executor runtimes. The relay command itself and its durable
state transition must remain real.

The test must set initial relay state to:

```text
phase=a-upgrade-pending
activeRole=null
stableCommit=<fixture SHA>
```

It must then execute the actual approval path through the dashboard and assert all of:

- no `Pause` relay command was issued;
- `CompleteAUpgrade` was invoked once from passive copy-a on
  `codex/reciprocal-a`, with `-Role A`, `-Force`, and a non-empty summary;
- the actual relay result is `A_UPGRADE_COMPLETED`;
- persisted relay state is `phase=idle`, `activeRole=null`, `nextRole=A`;
- the normal mock promotion path is invoked once for a new approval;
- audit steps retain the meaningful order: boundary, review, executor stop, promotion,
  executor restart, A-upgrade completion.

The harness must fail if the terminal command runs from copy-b, if it attempts generic
`Resume`, or if it merely simulates the relay result rather than calling the relay
script.

### 2. Add real isolated recovery-path coverage

Using an isolated fixture in the exact stranded state:

```text
phase=paused
pausedFromPhase=a-upgrade-pending
activeRole=null
stableCommit=<approved fixture SHA>
```

with an approved review and matching A/B BUILD_INFO values, invoke the real recovery
endpoint/path and assert:

- it executes only `CompleteAUpgrade` through passive copy-a with Role A and `-Force`;
- it does not invoke the runtime promotion helper, executor stop/start, generic Resume,
  or any wishlist action;
- durable state becomes idle;
- audit mode is `already-promoted-relay-gate-recovered`.

Also prove a wrong paused origin, active role, review decision, stable SHA, or either
BUILD_INFO mismatch makes **no state-changing command at all**.

### 3. Preserve the D171 live result and scope

Do not repeat the live recovery and do not re-promote `ead38ad`. Do not change W0026,
W0027, candidate state, or executor checkpoints. Do not weaken the relay guard.

If the new end-to-end harness exposes a defect, repair only that defect and extend the
test. Otherwise, this should be test-only/dashboard-harness work.

## Required checks

Run and record:

- the new end-to-end approval-flow test;
- the new end-to-end recovery test and its negative cases;
- existing `node --test C:\Users\huizh\Apps\Tandem Reciprocal\dashboard\lib.nodecheck.mjs`;
- `node --check C:\Users\huizh\Apps\Tandem Reciprocal\dashboard\server.mjs`;
- `node --check C:\Users\huizh\Apps\Tandem Reciprocal\dashboard\lib.mjs`;
- `npm run typecheck`;
- `npm test`;
- `git diff --check`.

After tests, capture read-only live proof that relay remains idle at `ead38ad`, both
runtime BUILD_INFO values match it, W0026 is DONE, and W0027 is still QUEUED.

## Safety constraints

- Do not call the live approval or live recovery endpoint as part of tests.
- Use a temporary fixture with separate state, audit, runtime metadata, and worktrees.
- Never invoke a real runtime copy, executor stop/start, or browser process from the
  test fixture.
- Preserve unrelated user changes.
- Do not create a product candidate or implementation commit for W0027.

## Completion

Commit test/harness changes with `D172-<n>:` subject(s), then add
`handoffs/D172_done.txt` separately.

The done marker must include the exact fixture command log proving passive routing and
absence of Pause/Resume in the A-upgrade case, real relay status before/after, recovery
negative-case proof, all changed files, and explicit confirmation that no live runtime
or wishlist state was changed.
