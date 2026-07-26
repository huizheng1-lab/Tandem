# Handoff D201 (dashboard's candidate-preview "Launch candidate"/"Approve and promote" gate reads the retired legacy relay state, which is permanently frozen at the pre-D196 a-upgrade-pending snapshot — blocks the human from reviewing/launching any candidate build)

## Live finding (verified — don't re-derive)

The human reported "I cannot launch the candidate from dash." Root cause confirmed
by direct code + file inspection:

`dashboard-source/reciprocal-control-panel/server.mjs`'s `currentCandidateOrThrow`
(~line 1481) reads `relayState` from
`path.join(repoRoot, ".git", "tandem-relay", "state.json")` — the **legacy relay
state file**, which D196-D199 retired in favor of
`orchestrator-state.json`/the reciprocal orchestrator. Nothing writes to the
legacy file anymore, so it is permanently frozen at whatever it held at the
moment of the D196 cutover:

```
phase: "a-upgrade-pending", stableCommit: "efb3b06a37390fcf191eb9f07f4fa479d49faee7"
```

`currentCandidateOrThrow` (line ~1490) does:
```js
if (relayState.phase === "a-upgrade-pending" && relayState.stableCommit && candidate.sourceSha !== relayState.stableCommit) {
  throw new Error(`Candidate build ${candidate.shortSha} does not match accepted stable ${shortSha(relayState.stableCommit)}; rebuild the preview before launch or review.`);
}
```

Since the frozen `phase` is permanently `"a-upgrade-pending"` and the frozen
`stableCommit` will never again match any freshly built candidate, this throws
for **every** candidate build going forward, unconditionally. The "Launch
candidate" and "Approve and promote"/"Reject" controls on the "Candidate runtime
update" panel are now permanently broken.

This is the same defect class fixed four times already today (D190, D192, D197,
D198: a component reading retired/stale state instead of the current source of
truth) — this is a fifth instance, in a part of the dashboard nobody had
exercised live until now: the candidate-preview review flow for the human's own
daily-use Tandem app (distinct from the executor-A/B reciprocal loop D196-D200
cover).

## Scope note

This "Version inventory" / "Candidate runtime update" panel governs promoting
build candidates into the human's own desktop app release
(`release/win-unpacked`), separate from the executor-A/B swap machinery D196
replaced. Confirm during this round whether this whole review-and-launch flow
should:
(a) be repointed at the new orchestrator's state/concepts (if `stableCommit`/
`a-upgrade-pending`-equivalent still has a meaningful analogue there), or
(b) be redesigned as its own independent gate now that the reciprocal loop no
longer produces an "a-upgrade-pending" concept at all (the new orchestrator has
no equivalent phase - it's idle/improving/swapping/failed-paused).
Pick whichever preserves the actual human workflow (reviewing a build before it
becomes the human's daily-use app) and document the decision.

## Fix

1. Stop reading the legacy `.git/tandem-relay/state.json` in
   `currentCandidateOrThrow` and anywhere else in the dashboard that still
   references it for live decisions (grep the whole file for `statePath` uses).
2. Repoint the staleness/match check at whatever the correct current source of
   truth is per the scope decision above.
3. Sweep dashboard-source for every other read of the legacy relay state path and
   fix or explicitly justify each remaining use (e.g., a clearly-labeled
   historical/audit display is fine; a live gating decision is not).
4. Regression: a fixture proving the Launch/Approve/Reject candidate-review flow
   works correctly against a fresh candidate build when the legacy relay file is
   absent or arbitrarily stale, and correctly still detects a genuine staleness/
   mismatch condition using the real current-state source.

## Constraints

- Do not weaken the underlying safety intent (don't launch/promote a candidate
  that doesn't match what's actually been accepted) — fix which state answers
  that question, don't remove the check.
- Do not touch W0023/the orchestrator's D200 work; this is an independent bug in
  a different dashboard panel.
- Deploy dashboard changes only through `scripts\deploy-reciprocal-dashboard.ps1`.

## Acceptance

`handoffs/D201_done.txt`: the scope decision (what state now governs this panel),
the fix, the dashboard sweep results, regression coverage, and live proof that
the human can actually click "Launch candidate" (or "Approve and promote") on a
current real candidate build and have it succeed. tsc + `npm test` green. Commit
`D201-<n>:`. Create `handoffs/D201_done.txt`.
