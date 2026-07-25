# Handoff D163 (D162 artifact lifecycle passes only in a synthetic topology and cannot complete the real Reciprocal preview workflow)

## Review verdict

D162 is **not approved**. Keep its useful direction/relay primitives, but repair the
production blockers below. This handoff is a review correction only; do not implement
W0021's Telegram UX request or W0016 step 3.

## P0 production blocker: producer HEAD is not the artifact source SHA

The real W0020 topology deliberately had two different sources of truth:

- Reciprocal producer worktree `copy-b` and relay stable were at `78726ab`.
- The review artifact was packaged from the separate admin workspace
  `C:\Users\huizh\Apps\HZ code` at local master `feed434`.
- The artifact lived at the admin workspace's canonical
  `release\win-unpacked`, not under `copy-b`.

D162's `completeReciprocalArtifact` cannot complete that real task:

- `src/reciprocal/candidate-commit.ts:277` requires producer `HEAD` to equal
  `artifact.sourceSha`. In the real case this compares `78726ab` with `feed434` and
  fails, even though the relay turn is correctly commit-free.
- `src/reciprocal/candidate-commit.ts:116,281,286` normalizes both artifact paths as
  repository-relative and joins them to `options.cwd` (the producer worktree).
  Absolute paths are rejected by `normalizeReportedPath`; therefore it cannot inspect
  the real admin workspace's `BUILD_INFO.json` or `Tandem.exe`.
- `src/reciprocal/candidate-commit.ts:329` passes producer `head` to
  `ArtifactComplete -Commit`, so the board records `source=78726ab` instead of the
  reviewed candidate source `feed434`. Dashboard origin lookup compares the reviewed
  SHA to `source`, so a later rejection still cannot map the review to its origin.

The D162 candidate-commit test hides all three defects by making the fake producer
HEAD, fake artifact source, and fake artifact directory the same `abc123` scratch
repo. Add a real-topology fixture with distinct producer/stable and artifact-source
SHAs and distinct producer/admin roots; it must fail before the fix and pass after.

## P0 trust blocker: artifact mode and smoke evidence are model-asserted

`CompletionReport.reciprocalArtifact` is optional metadata supplied by the model. The
board item itself is not explicitly declared artifact-only when added, and no executor
instruction/schema routing added by D162 guarantees that a worker will emit this
field. Conversely, a model can opt an ordinary queued item into the no-commit path.

The new code also trusts `smoke.passed=true` and `exitCode=0` from the report. That is
not machine verification; it is a model assertion. A false report can mark the item
DONE without the unsandboxed app layer ever launching the executable.

Repair this with an explicit, human/app-owned declaration and app-layer evidence:

1. Persist artifact kind and trusted source workspace/config on the wishlist item (or
   equivalent app-owned state) before execution. Do not infer it from prose and do not
   let the completion report create artifact authority.
2. Resolve the canonical admin workspace from trusted Reciprocal/dashboard
   configuration. Permit only the canonical `release\win-unpacked\BUILD_INFO.json`
   and `Tandem.exe` beneath that resolved root; reject arbitrary model-supplied
   absolute paths and traversal.
3. Keep the producer guard separate: producer HEAD must equal relay base/stable and the
   worktree must be clean. Artifact `sourceSha` may legitimately differ and must equal
   the trusted admin source requested by the item plus `BUILD_INFO.sourceSha`.
4. Run the terminating launch smoke in the unsandboxed app layer (or consume a signed/
   persisted app-layer result), rather than trusting a boolean in model output.
5. Record `ArtifactComplete source=<artifact source SHA>`, while relay
   `lastCompletedCommit` may remain the unchanged producer/stable HEAD.
6. Make the executor prompt/report path deterministic so a declared artifact item
   produces the required report without relying on the model guessing a hidden schema.

## P1 atomicity blocker

The app layer currently calls direction `Start`, then `ArtifactComplete` (which marks
the item DONE), then relay `CompleteArtifact`. If the final relay call fails, the board
says DONE while the relay remains working/paused—the same class of split-brain D162
was meant to eliminate.

Make the transition transactional or safely compensating:

- validate all board, relay, worktree, source, BUILD_INFO, executable, and smoke
  preconditions before either state is mutated;
- commit board and relay terminal state under one guarded operation/lock where
  practical, or implement tested rollback/recovery that cannot silently leave DONE +
  working;
- make retry idempotent after interruption at each mutation boundary.

Apply the same standard to dashboard rejection: follow-up creation, explicit origin
retirement, review persistence, and safe relay closure must either finish coherently
or expose a recoverable failure. Never retire unrelated active work.

## Missing acceptance coverage from D162

D162 did not perform the required isolated live proof and did not add dashboard
endpoint integration coverage. Its done report explicitly says the live proof was not
run. Scratch repos/boards were allowed and required; W0021 being active was not a
reason to skip an isolated relay root and dashboard port.

Add coverage for all of the following:

1. Distinct topology: producer HEAD/stable `AAA`, admin source/artifact `BBB`, and
   separate roots. Completion succeeds, stable remains `AAA`, board records
   `source=BBB`, and no candidate ref/commit/runtime promotion occurs.
2. Trusted item declaration: an ordinary source item cannot opt itself into artifact
   completion by returning `reciprocalArtifact`; a declared artifact item can.
3. App-layer smoke: prove the app layer executes the terminating check and refuses
   missing executable, launch failure, timeout, or source mismatch. A report claiming
   success must not bypass these failures.
4. Every required refusal from D162: dirty producer, moved HEAD, wrong role, wrong or
   unowned item, missing/mismatched BUILD_INFO, incomplete report, pending candidate,
   and rollback state.
5. Transaction faults after each boundary (start, evidence validation, board terminal
   write, relay terminal write) leave a retryable coherent state and do not duplicate
   completion/audit history.
6. Real dashboard endpoint tests: reject a distinct-topology scratch preview, create
   one deduplicated follow-up with the full comment, map it to the exact origin using
   explicit metadata, retire only when appropriate, and leave the scratch relay idle.
7. Repeated rejection and repeated completion are idempotent.
8. The normal source path still performs
   `QUEUED -> IN_PROGRESS -> CANDIDATE -> DONE`, and W0016-style plan metadata remains
   unchanged.

Do not weaken path safety merely to support the external admin root. The root must be
trusted configuration, and resolved evidence paths must remain beneath its canonical
release directory.

## Deployment and compatibility

The authoritative implementation is committed in the admin repo, while the active
dashboard lives at `C:\Users\huizh\Apps\Tandem Reciprocal\dashboard` and active
executors use pinned Reciprocal worktrees/runtimes. Update the version-controlled
source/setup path and apply the external dashboard runtime consistently, but do not
promote runtimes or integrate/push master automatically. State exactly which pieces
become active immediately and which remain behind existing human gates.

Preserve existing user changes and unrelated dirty/untracked files. Do not mutate the
real W0021 or W0016 board entries during proof.

## Verification and completion

Run the focused candidate-commit, direction, relay, dashboard nodecheck, and dashboard
endpoint tests; `node --check` on changed dashboard modules; `npm run typecheck`; full
`npm test`; and `git diff --check`.

Perform the required live proof using an isolated scratch relay root, scratch board,
temporary artifact/admin workspace, and isolated dashboard port. Demonstrate
artifact completion, human rejection, origin mapping, one follow-up, and clean idle
relay without manual cleanup.

In `handoffs/D163_done.txt`, document the distinct SHAs/roots used, app-layer smoke
evidence, fault-injection/idempotence evidence, exact dashboard test/live commands,
and deployment status. Commit implementation with `D163-<n>:` subject(s), then commit
the done marker separately.
