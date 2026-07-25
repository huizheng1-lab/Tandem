# Handoff D164 (D163 still cannot complete a real preview: no declaration path and Tandem.exe has no --smoke mode)

## Review verdict

D163 is **not approved**. Its distinct producer/artifact topology and relay-before-board
ordering are useful and should be preserved, but two production blockers remain.
Do not implement W0021 or W0016 in this round.

## P0: the default smoke check always fails for the real GUI executable

`src/reciprocal/candidate-commit.ts` now executes `Tandem.exe --smoke` with a 15-second
`execFile` timeout and requires the process to exit successfully. Tandem implements no
`--smoke` argument or self-terminating smoke mode; repository search finds the flag
only in D163's new caller/test metadata.

Live review evidence on the current canonical preview:

```text
Start Tandem.exe --smoke
wait 5 seconds
exitedWithin5s=false
```

The reviewer then terminated PID 28576. This is the expected behavior of a healthy
Electron GUI, but D163 interprets it as a timeout failure. D163's unit tests inject
`artifactSmokeRunner`, so none exercise the broken default. Its dashboard live proof
tested rejection only; it did not run artifact completion with the real default smoke.

Implement a real unsandboxed GUI smoke appropriate to Tandem. Acceptable designs
include:

- launch the executable with isolated candidate-preview user-data, wait for a genuine
  readiness condition (`WaitForInputIdle`, automation health endpoint, or equivalent),
  then terminate the exact launched process tree and treat responsive launch as pass;
- or add a real, tested application-owned smoke mode that exits only after startup
  initialization succeeds, while retaining compatibility for candidate builds that
  predate that mode.

Requirements:

- never mistake "GUI remains open" for failure;
- enforce a bounded timeout and always clean up only the exact process tree launched
  by the smoke check;
- avoid the real user's profile and use the isolated candidate-preview state/user-data;
- surface launch, readiness, timeout, crash, and cleanup failures distinctly;
- do not trust model-reported smoke booleans;
- record machine evidence used in the artifact completion audit hash/history.

Add tests for responsive long-running GUI, early nonzero exit/crash, readiness timeout,
missing executable, and process cleanup. Include one live proof against the actual
canonical `release\win-unpacked\Tandem.exe` showing readiness was detected and no
smoke-launched process remained afterward.

## P0: no human/app declaration or deterministic worker path exists

D163 added `reciprocal-direction.ps1 -Action DeclareArtifact`, but nothing in the
active dashboard, wishlist creation endpoint/UI, executor protocol, TANDEM prompt, or
setup path invokes it:

- the active dashboard contains no `DeclareArtifact`, `artifactKind`, or
  `reciprocalArtifact` handling;
- the active Executor A instructions contain no artifact-only report guidance;
- a normal dashboard wishlist item remains plain `QUEUED`, so D163 rejects the report
  as undeclared;
- the only way to prepare such an item is another manual/script intervention—the exact
  operational dependency D162/D163 were meant to remove.

Also, `DeclareArtifact` is a general script action available in the producer worktree.
Merely asking the model to call it does not make the declaration human/app-owned.

Build an explicit control-plane flow:

1. Dashboard/API wishlist creation must support a clearly labeled review-artifact item
   type (currently only `candidate-preview`) and bind it to an exact trusted local
   master/source SHA resolved by the app, not arbitrary model input.
2. Persist the declaration and an audit event before the item is eligible for Claim.
   Prefer creating the item with immutable artifact/source metadata in one guarded
   operation. Remove or restrict the standalone post-creation declaration path so an
   executor cannot convert an ordinary source item into a no-commit artifact task.
3. The claim/executor prompt must deterministically expose the declared type, wishlist
   ID, trusted source SHA, and required completion-report shape. The worker should not
   have to guess an optional hidden schema field.
4. The unsandboxed app layer—not the model—must resolve the trusted artifact root,
   perform provenance and smoke checks, and close the lifecycle.
5. Existing ordinary wishlist creation remains source-work by default and cannot enter
   artifact completion from model output alone.

If UI changes are unnecessary because artifact jobs are created only by a dedicated
"Build latest for review" dashboard action, implement that dedicated audited action
instead. The human must be able to initiate it without Codex editing the board.

## End-to-end proof required

Use an isolated relay root/board/dashboard port and a temporary trusted source root,
plus the real packaged Tandem executable where appropriate. Demonstrate the complete
path, not only helper calls:

1. human/control-plane creates one declared artifact item bound to source `BBB` while
   producer stable/HEAD remains distinct `AAA`;
2. scheduled/Claim selects it and receives deterministic artifact instructions;
3. a zero-source-files completion report triggers app-owned BUILD_INFO validation and
   the real terminating GUI smoke;
4. relay closes to idle, stable/last producer commit remains `AAA`, board becomes DONE
   with `source=BBB`, and no candidate ref, source commit, runtime promotion, or master
   integration occurs;
5. review rejection maps `BBB` to that exact origin, creates one follow-up, and repeated
   rejection is idempotent;
6. no manual DeclareArtifact, Resume, Abandon, board edit, or operator cleanup is used.

Add dashboard endpoint/integration tests for creation/declaration—not only rejection.
Add a test proving an executor/model cannot convert a normal item after creation.

## Retry and compatibility checks

Preserve D163's relay-first transition and distinct-topology behavior. Test retries
after relay close and after board completion. If a legacy D162 state already has board
DONE while relay remains working, detect it and provide a safe, explicit recovery
instead of silently returning early.

State precisely which code is active immediately in the external dashboard and which
executor/app-layer changes remain behind runtime promotion. Do not bypass the existing
human runtime-promotion or main-integration gates. Do not mutate real W0021 or W0016
during tests/live proof.

## Verification and completion

Run dashboard `node --check`, nodecheck, and endpoint tests; focused reciprocal
candidate/direction/relay tests; GUI smoke tests; `npm run typecheck`; full `npm test`;
and `git diff --check`.

In `handoffs/D164_done.txt`, include:

- actual canonical executable smoke command/readiness evidence and cleanup proof;
- the audited control-plane artifact creation request/result;
- distinct `AAA` producer and `BBB` artifact SHAs/roots;
- final board/relay/ref state;
- repeated rejection evidence;
- exact activation/deployment status.

Commit implementation with `D164-<n>:` subject(s), then commit the done marker
separately.
