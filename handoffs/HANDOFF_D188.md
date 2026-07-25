# Handoff D188 (finish D187's required-but-missing safety regressions — the mutating-lifecycle and bounded-retry protections are live but untested)

## Review verdict on D187 (independent, live-verified — don't re-derive)

D187-1's live recovery is verified and its core persistence fix is sound, but the
round is not approved because required safety contracts and regressions remain
incomplete:

- Strict UTF-8 relay JSON reads/writes and a 5 MB canonical-state read cap are
  present; the live recovered `state.json` (4,422 bytes) held byte-for-byte
  identical SHA256 across the reviewer's own independent `Status` invocations.
- `Status` is genuinely read-only now (no `Save-State` call).
- `Limit-Text` truncates by UTF-8 bytes; identity parsing tolerates mojibake glyphs.
- `Test-StableBaselineControlAllowed` now rejects obvious metacharacters,
  interpreters, lifecycle scripts, and live/absolute paths, and the spoofed
  `node`/chained-command regression passes. However, its raw-command regex still
  has a trailing-argument escape described below and is not yet approved as a
  complete trust boundary.
- Oversized fail-closed and recovery-idempotence tests exist and pass (reviewer
  re-ran: relay 28/28, supervisor 8/8, smoke 4/4, tsc clean).
- W0027's hard gate survived recovery untouched.

**HANDOFF_D187 section 4 and its required state-persistence regressions were only
partially implemented.** Verified missing by direct inspection of the committed
source and tests at `ce1de0f`:

1. **No B-promotion or B-launch failure-injection tests.** Only D186's package
   lifecycle test exists (`tests/reciprocal-relay.test.ts:~1193`,
   `classifier: "lifecycle-operation"`). Nothing injects an Executor B runtime
   *promotion* failure or *launch* failure and proves: (a) the mutating helper ran
   exactly once for the real candidate operation, (b) it was never replayed as a
   stable-baseline control, (c) runtime/process/journal/release sentinels are
   untouched by the diagnosis path, (d) the pause records
   `operationKind = "b-runtime-promotion"` / `"b-runtime-launch"` with
   `baselineControlSkipped = true`.
2. **No positive supervisor test for the bounded environment-failure retry.**
   `tests/reciprocal-supervisor.test.ts` (still 8 tests) covers only the negatives
   (human-origin and unknown-origin pauses are not auto-resumed, line ~199). There
   is no test proving a machine-origin `environment-failure` pause with a pending
   candidate performs **exactly one** `Resume -> PassiveTest` transition (the
   `environment-failure-retry` action path added in D186 to
   `scripts/continue-reciprocal-automation.ps1`).
3. **No backoff/circuit-breaker escalation test for repeated environment
   failures.** Existing backoff tests (D177/D179) cover `endpoint-unavailable` and
   `source-reconciliation-pending`, not the environment-failure retry path: nothing
   proves repeated environmental failures enter bounded backoff and then the hard
   circuit breaker, with no extra Resume/PassiveTest while backed off or
   hard-blocked.
4. (Smaller) **No automated repeated-save byte-stability regression.** The 100×
   Status stability was proven live (good), and D185/D186 fixtures now carry
   `❯ × 智能路径` through the real save/load pair, which implicitly covers the
   encoding round-trip — but there is no explicit test that N consecutive
   *mutating* saves of a state containing that content stay byte-identical in the
   persisted evidence. Add one cheap loop test (a handful of save/load cycles
   asserting stable bytes/hash of the non-timestamp content) so the 7/20- and
   7/23-class amplification can never regress silently.

5. **The canonical-state writer in the supervisor does not share the relay's
   atomic/size contract.** `scripts/continue-reciprocal-automation.ps1:230-232`
   routes `Save-RelayState` to `Write-JsonFile`, but `Write-JsonFile` at lines
   50-52 directly calls `WriteAllBytes` with no temporary-file replacement and no
   5 MB output cap. The D187 handoff explicitly required every other canonical
   state reader/writer to use the same encoding and size contract. Make only the
   canonical relay-state write atomic and size-capped (preserve the existing
   encoding); add focused assertions that an oversized serialized state fails
   closed without replacing the prior valid file and a normal write is atomic.

6. **The raw validation-command grammar accepts trailing Vitest options hidden in
   the greedy “test path” character class.**
   `scripts/reciprocal-relay.ps1:637-639` permits whitespace inside
   `[^"&|;<>]+`, so inputs such as
   `npm test -- tests/example.test.ts --config tests/side-effect.ts` and the
   analogous `vitest run` form can satisfy the allowlist. That reopens executable
   configuration/setup hooks during stable control. Replace this with structured
   token validation or a truly narrow grammar that permits only one or more
   test/spec paths and explicitly safe reporter/filter syntax if required. Add
   negative tests for `--config`, `--setupFiles`, traversal, and extra non-test
   tokens, plus positive tests for the exact supported commands.

7. **Two explicit D187 persistence/recovery regressions are still absent.**
   Add an invalid-UTF-8/invalid-JSON state fixture that proves fail-closed behavior
   without mutation, and assert persisted diagnostic limits by UTF-8 byte count
   using multibyte text (not JavaScript character count). Also make the recovery
   fixture prove that missing top-level `candidateCommit` or `stableCommit` is
   rejected instead of silently substituting relay refs; the current recovery
   script falls back to refs at lines 110-111, which does not validate the bounded
   state prefix as required.

These are the exact protections that failed or nearly failed in the last three
rounds (mutating replay was THE critical D186 gap; the retry loop is what amplified
the 2GB state) — they must not remain untested.

## Work

Add all seven regression/correction groups above. Most work is test coverage, but
items 5-7 include narrow implementation corrections already demonstrated by
source inspection. If the lifecycle/retry tests expose another real defect (for
example, the bounded retry does not stop after one action or a lifecycle sentinel
is touched), fix the defect in the same round and say so explicitly in the done
notes — do not adjust the test to match broken behavior.

Reuse the existing fixture machinery (`enableVitestFixture`, the relay/supervisor
test harnesses, sentinel patterns from the D186 package test) rather than building
parallel scaffolding.

## Constraints

- Do not weaken or restructure any existing passing test.
- Do not touch the live relay state, the quarantined 2.05GB file, W0027's paused
  `candidate-failure`, or the reciprocal worktrees/runtimes — this round needs no
  live-state interaction at all beyond leaving it alone.
- Do not modify `Test-StableBaselineControlAllowed`'s new grammar except to close
  the verified item-6 escape while preserving the narrow positive commands.

## Acceptance

`handoffs/D188_done.txt` listing each added test by name with what it proves, and
flagging any real defect found and fixed along the way. Full relay + supervisor
suites green, tsc + `npm test` green, `git diff --check` clean. Commit
`D188-<n>:`. Create `handoffs/D188_done.txt`.
