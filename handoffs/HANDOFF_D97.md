# Handoff D97 (workflow core: orchestrator-executed verification + retry-with-feedback)

Two changes in one orchestrator-focused round. They are the top two items in
`IMPROVEMENT_SUGGESTIONS.md` (v2, §B1/§B2), justified by real incidents: D90 (worker + takeover
burned 4 attempts because echo string-matching was too strict) and D96 (6 attempts burned on a
tampering-check false positive). Both bug classes exist because Tandem validates what the model
SAYS about verification instead of running verification itself, and because rejected attempts
retry blind with no idea why they were rejected.

## D97-1: orchestrator-executed verification (ground truth instead of model echo)

### Design (decided — don't re-litigate, but flag genuine blockers if found)

Add an injectable dependency to `RunOptions` in `src/orchestrator/machine.ts`, mirroring the
existing `diffProvider` pattern (machine.ts:65):

```ts
verificationRunner?: (commands: string[]) => Promise<Array<{ command: string; passed: boolean; output: string }>>;
```

The orchestrator stays engine/tool-agnostic — the RUNNER is provided by the three callers that
already wire `diffProvider` (`app/main/tandem-service.ts` ~line 230, `src/tui/App.tsx` ~line
289, and the CLI entry if it wires orchestration similarly — check `src/index.ts`). Implement
it once in shared code (suggest `src/orchestrator/verification.ts` or similar) using the
existing `bashTool` (`src/tools/shell.ts`) with the project cwd, a per-command timeout constant
(suggest 300s — verification commands are required to be finite per `finiteVerificationRule`,
but a runaway one must not hang the orchestrator), and output captured/truncated to a sane cap
(reuse an existing truncation helper; full output can go to the session log, the capped form
into the report).

**Where it hooks in `machine.ts`:**
- After the per-round worker report(s) are merged (`mergeCompletionReports`, ~line 448) and
  BEFORE the review call (~line 472): run `plan.verification` once via the runner. Attach the
  results to the report as the authoritative `verificationResults` (replace the model-reported
  array; optionally preserve the model's own claims under a new advisory field if trivial, but
  don't bloat — replacing is fine since the session log already recorded what the model said).
- Same treatment in `runTakeover` after `validateCompletionReport` (~line 364).
- Emit a `notice` machine event per run ("verification: 4/5 passed") so the UI shows it.

**Permission-mode handling (decided):** run automatically when `permissionMode` is `auto-edit`
or `yolo`. In `ask` mode, request ONE batched approval via the existing `permissionBridge`
("Run the plan's N verification commands?") — if denied or no bridge available, skip the
authoritative run and keep current behavior (model-reported results), emitting a notice saying
so. Do not invent a new permission mechanism.

**What this replaces / relaxes in `src/orchestrator/artifacts.ts`:**
- `enforceVerification`'s "omitted verification commands" throw (and therefore D90's
  `looselyEquivalentCommand` fuzzy matching) stops being load-bearing: when an authoritative
  run happened, do NOT reject a report for omitting/misquoting commands — the orchestrator's
  own results are attached regardless. Keep the schema validation. Keep the check active as a
  fallback ONLY for the path where the authoritative run was skipped (ask-mode denial).
- The "marked complete with failing verification" check becomes MORE meaningful: compare
  `status: "complete"` against the AUTHORITATIVE results. A report claiming complete while a
  real command fails should not hard-reject the artifact (that's D96-style waste) — instead
  let it through to REVIEW with ground truth attached; the reviewer sees the discrepancy and
  issues a revise with concrete feedback. That converts a retry-burn into a normal review
  round, which is the machinery designed for exactly this.

**Explicitly KEEP (correction to IMPROVEMENT_SUGGESTIONS v2, which overstated this):** the
D56-2 tampering check (`detectVerificationScriptTampering`, with D96's planned-deliverable
exemption) stays. Orchestrator-run verification does NOT make it redundant — a worker that
rewrites a verification script to vacuously print success will pass the orchestrator's run too;
the undisclosed-edit check is the layer that catches that. The two defenses are complementary.

## D97-2: retry-with-feedback (rejected attempts learn why)

`retryArtifact` (machine.ts:86) currently re-invokes a fixed producer closure — attempt 2/3
have zero knowledge of why attempt 1 was rejected. Same for `runTakeover`'s inline 3-attempt
loop (~line 360).

- Change `retryArtifact`'s producer signature to `producer(previousError?: unknown)` and pass
  the prior attempt's error. Update the call sites (plan ~316, per-stream build ~173-186,
  review ~472, and `runTakeover`'s loop).
- Thread it into the agent inputs as an optional field (suggest `previousAttemptError?: string`
  — String(error), truncated to a few hundred chars) on the existing input objects:
  `BuildStreamInput`, the review input, takeover input, plan input. Each engine implementation
  (`src/agents/live.ts`, `codex-cli/leader.ts` + worker, `claude-code-cli/leader.ts` + worker)
  appends one line to its user prompt when present, e.g.:
  `"Your previous submission was rejected: <reason>. Fix that specific problem and resubmit."`
- Keep it terse — one line, capped length, no full stack traces (sanitized message only; note
  the D89 lesson about giant error strings).

D97-1 makes most CURRENT rejection causes disappear; D97-2 covers everything left (schema
validation failures, tampering-check hits, future validators) and any path where the
authoritative run was skipped.

## Out of scope (recorded, do not build this round)

- `reviewPolicy: "smart"` auto-approve (IMPROVEMENT_SUGGESTIONS v2 §A2) — designed to sit on
  top of D97-1's ground truth; separate round once this settles.
- Review-prompt diet (§A1), complexity-adaptive triage (§B3), worker nudge (§B4).

## Acceptance

tsc + `npm test` green. Required tests:
1. Orchestrator attaches authoritative verification results: a fake `verificationRunner`
   returning known pass/fail results → merged report's `verificationResults` match the
   runner's output, not the model's claims; a `notice` event was emitted.
2. A report omitting/misquoting verification commands is NOT rejected when the runner ran
   (no "omitted verification commands" throw on that path); the fallback path (runner absent)
   still enforces as today.
3. `status: "complete"` + authoritative failure → artifact accepted, proceeds to review (not
   retry-burned); the attached results show the failure.
4. Tampering check still fires on an undisclosed edit to a verification script not in task
   files (D56-2/D96 behavior unchanged).
5. Retry-with-feedback: a producer that fails validation on attempt 1 receives the rejection
   text on attempt 2 (assert the prompt/input contains it) — cover at least the build and
   review call sites; takeover loop too.
6. Ask-mode: runner requests one batched approval via the bridge; denial falls back cleanly.

Live verification (required, this changes the core loop): rebuild the packaged app and run a
real small task end-to-end (minimax/minimax-m3 both roles, `triage: auto`, yolo) and confirm:
(a) the session log shows the orchestrator-run verification notice with real command results,
(b) clean DONE. Then run a task designed to FAIL verification on round 1 (e.g. plan verifying
an assertion the task intentionally gets wrong) and confirm it flows to a review-revise round
with the real failure visible to the reviewer rather than artifact-retry-burning. Paste both
session outcomes in the completion report. Commit `D97-<n>:`, create `handoffs/D97_done.txt`.
