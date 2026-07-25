# Handoff D195 (dashboard's Approve-and-promote fails on "Executor B endpoint token file mismatch" — the dashboard's endpoint verification never got D190's schema tolerance; also de-duplicate this logic so CLI and dashboard can't drift again)

## Live incident (verified — don't re-derive)

The human clicked **Approve and promote** on the dashboard's Candidate runtime
update gate (candidate `efb3b06`, relay at `a-upgrade-pending`) and got:

```
Executor B endpoint token file mismatch.
```

Verified live: Executor B's `/status` endpoint (PID 35592, port 4784) returns
`ok/pid/instanceId/projectDir/sessionId/running/capabilities` — **no `tokenFile`
field at all**. That's the "older B /status schema" D190-2 already identified;
D190 made the CLI relay tolerant
(`scripts/reciprocal-relay.ps1:2227` checks `tokenFile` only if the property
exists and is non-empty), but the dashboard's duplicate of the same check —
`dashboard-source/reciprocal-control-panel/server.mjs:1638` in
`verifyRuntimeEndpoint` — still requires the field unconditionally:

```js
if (!endpoint.tokenFile || path.resolve(endpoint.tokenFile)... ) throw new Error(...)
```

So the approval flow dies at B verification. Relay state is untouched (still
cleanly `a-upgrade-pending`, stable `efb3b06`) — the gate correctly failed before
mutating anything. The human's approval intent is real and pending.

## Fix

1. **Align the dashboard check with D190's CLI tolerance**: in
   `verifyRuntimeEndpoint`, enforce the `tokenFile` (and any other echo-only
   fields D190 relaxed: port/token/source/package echoes) only when the endpoint
   actually reports them, while keeping the hard checks that D190 kept hard
   (PID match, instance ID, target dir, capability, runtime BUILD_INFO/package
   identity, process path). Compare against `reciprocal-relay.ps1`'s
   post-D190 verification block and make the two behaviorally identical.
2. **Kill the duplication**: this bug exists because the same endpoint
   verification lives twice — PowerShell (relay) and JS (dashboard server) — and
   D190 fixed one copy. Consolidate: either extract one shared implementation
   (e.g. the dashboard invokes the relay script / a single shared verification
   module or subcommand and consumes its structured result), or, if a full
   consolidation is too large for this round, add a cross-implementation
   conformance test that runs BOTH verifiers against the same fixture endpoint
   payloads (with/without tokenFile, mismatched PID, wrong instance, missing
   capability, old schema) and asserts identical accept/reject outcomes. State
   which you did and why.
3. **Sweep for other drifted duplicates**: grep the dashboard server for other
   re-implementations of relay-side checks (package attestation, journal stage
   logic, gate classification) and either reuse the canonical source or add them
   to the conformance fixture set. List what you found in the done notes.
4. **Regressions**: dashboard-side (nodecheck/e2e) cases for an endpoint payload
   without `tokenFile` passing verification when everything else matches, and
   still failing on each genuinely-hard mismatch.

## After the fix

Redeploy the dashboard only via `scripts/deploy-reciprocal-dashboard.ps1`
(verify source/target hashes), then let the human retry **Approve and promote**
for `efb3b06` — that retry is the live proof. Do not perform the A-runtime
promotion yourself; the human explicitly owns that action. If the human instead
completes the promotion via the CLI before this lands, the retry proof becomes:
demonstrate the fixed dashboard verification passing against live B in a
non-mutating mode (or fixture), and say so.

## Constraints

- Do not weaken any genuinely-hard verification (PID/instance/target/capability/
  BUILD_INFO/package identity/process path) in either implementation.
- Dashboard deploy only through the managed script.
- Do not cross the A promotion gate autonomously.

## Acceptance

`handoffs/D195_done.txt`: the alignment diff summary, the consolidation-or-
conformance decision and its coverage, the duplication-sweep findings, regression
names, deploy verification, and the live outcome of the human's retried approval.
tsc + `npm test` + dashboard nodecheck/e2e green. Commit `D195-<n>:`. Create
`handoffs/D195_done.txt`.
