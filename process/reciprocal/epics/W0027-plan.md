# W0027: Autonomous Execution-Environment Resolution

## Objective

Make Tandem workers, leader takeover, and authoritative verification use one capability-checked execution environment instead of relying only on `PATH`, ambiguous launcher tokens such as `py -3`, or broken placeholders. The environment must resolve Python interpreters and required modules, Node, ffmpeg/ffprobe, the Codex Windows sandbox helper, and task-declared network needs; identify the selected absolute executable paths; and name the exact capability that failed.

Takeover must re-resolve instead of inheriting a stale worker environment. Discovery and use of already-installed compatible runtimes are autonomous. Tandem must not silently install a dependency, request credentials, open network access, weaken a sandbox, substitute an inferior runtime, or treat a zero-byte executable as usable. A human authority gate is permitted only when the only truthful remediation requires dependency installation, credentials, task-required network permission, or sandbox/permission changes.

W0027 is `autonomy=plan-gated`. This candidate contains only this plan. Once the plan is approved, implement exactly one ordered source step per later relay candidate; do not combine, skip, or reorder steps.

## Shared invariants

- One canonical `ResolvedEnvironment` type records requested capabilities, resolved absolute paths, probe evidence, unresolved capabilities, and diagnostics. Workers and authoritative verification receive that record; takeover replaces it only with a freshly resolved record.
- Resolution is capability-based. A candidate is usable only after its executable and declared capabilities are probed. Selection prefers a compatible installed candidate over a newer or earlier-discovered incompatible candidate.
- Overrides are explicit and highest precedence, followed by shared `resolveOnPath` discovery and bounded platform-specific installed-runtime discovery. An override is still probed and may be rejected. The implementation reuses `src/tools/resolve-on-path.ts` and the precedence conventions in `src/agents/codex-cli/locate.ts` rather than creating a second generic PATH walker.
- A path must identify a real, non-zero-byte executable. Ambiguous launcher syntax is discovery input, never the selected executable recorded in the result.
- Network probes are bounded, apply only to hosts declared by the task, and never alter credentials, certificates, firewall rules, proxy settings, or sandbox policy.
- Diagnostics name the selected or rejected path, the exact capability, and the resolution sources tried. A genuinely unavailable capability yields one actionable blocker and cannot coexist with a misleading passed authoritative verification result.
- No dependency installation, credential change, network-permission change, sandbox weakening, product runtime promotion, protocol change, or unrelated feature work is part of an ordinary source step.
- Every candidate runs its focused tests, `npm run typecheck`, and `git diff --check`. Its verification list retains `authoritative-only: npm test` for the authoritative runner.

## Step 1 - Canonical capability resolver

Add the resolver and hermetic probes that produce a complete `ResolvedEnvironment` without changing orchestration behavior yet.

Expected source ownership:

- `src/environment/resolve.ts` (new): resolution policy, candidate ranking, bounded probes, and exact-capability diagnostics.
- `src/environment/types.ts` (new): requested-capability, resolved-environment, probe-result, and resolution-error types.
- `src/tools/resolve-on-path.ts` only if a tested Windows `PATHEXT` or explicit candidate-directory gap must be added to the shared walker.
- `src/agents/codex-cli/locate.ts` only if a small exported helper is needed to share its override/PATH/Windows-install precedence with sandbox-helper discovery.

Expected test ownership:

- `tests/environment-resolve.test.ts` (new) for injected filesystem, process, and network probes.
- `tests/resolve-on-path.test.ts` only if the shared PATH walker changes.
- `tests/codex-cli.test.ts` only if Codex discovery exports change.

Required behavior and simulations:

1. Multiple Python versions: simulate Python 3.12 without `edge_tts` and Python 3.10 with it; select the Python 3.10 executable for a request requiring `edge_tts`, while retaining rejection evidence for 3.12.
2. Broken placeholder: simulate an earlier zero-byte `python.exe`; reject it with an exact reason and continue to a usable interpreter.
3. Off-PATH ffprobe: simulate ffprobe in an explicitly registered ffmpeg directory that is absent from `PATH`; record its absolute executable path.
4. Missing module: simulate no Python candidate satisfying a required module; report that module as the exact missing capability without claiming Python is fully usable.
5. Blocked network: inject a timeout or connection/DNS failure for a declared host; record that host and failure without changing network settings.
6. Helper discovery: simulate the Codex Windows sandbox helper in an installed Codex location even when it is not independently on `PATH`; resolve the real helper path and reject missing/zero-byte helper files.
7. Node and ffmpeg: prove version/executable probes reject unusable candidates and record usable absolute paths.

Independent verification:

- `npm test -- tests/environment-resolve.test.ts tests/resolve-on-path.test.ts tests/codex-cli.test.ts`
- `npm run typecheck`
- `git diff --check`
- `authoritative-only: npm test`

The candidate checks only Step 1 complete in this plan.

## Step 2 - Normalized propagation and authoritative diagnostics

Resolve once for a normal orchestration run and propagate that same normalized record through worker agent execution and the authoritative verification runner. Extend failure reporting so the chosen path and exact capability are visible at both boundaries. Do not add takeover refresh or remediation gating in this step.

Expected source ownership:

- `src/orchestrator/environment.ts` (new): resolve-once orchestration context and environment-variable projection from `ResolvedEnvironment` without replacing unrelated inherited variables.
- `src/orchestrator/machine.ts`: create the normal-run context and pass it to worker dispatch and authoritative verification.
- `src/orchestrator/verification.ts`: accept the normalized environment when running verification commands and attach path/capability evidence to failures.
- `src/orchestrator/artifacts.ts`: validate and preserve additive capability diagnostics in completion/verification artifacts without weakening existing command validation.
- The existing agent construction/execution seam that supplies `CodexExecOptions.env` and equivalent worker environments; change the narrowest actual owner found during implementation rather than adding a parallel spawn path.

Expected test ownership:

- `tests/orchestrator-environment.test.ts` (new): worker and verification for one run observe the same resolved paths and unrelated environment variables remain intact.
- `tests/orchestrator.test.ts`: orchestration-level propagation and failed authoritative-verification behavior.
- `tests/artifacts.test.ts`: selected-path and exact-capability diagnostics are additive, and passed entries do not receive failure diagnostics.

Required behavior:

- Worker execution receives normalized variables for resolved tools and capability metadata from the one `ResolvedEnvironment` record.
- The `VerificationRunner` receives that same record rather than resolving commands independently from ambient `PATH`.
- A verification failure names the executable actually selected and the exact unsatisfied capability. A missing capability cannot be represented as passed, even if a command happened to exit successfully through a different runtime.
- Resolver failure produces one structured failure path, not duplicate worker and verification blockers.

Independent verification:

- `npm test -- tests/orchestrator-environment.test.ts tests/orchestrator.test.ts tests/artifacts.test.ts`
- `npm run typecheck`
- `git diff --check`
- `authoritative-only: npm test`

The candidate checks only Step 2 complete in this plan.

## Step 3 - Takeover re-resolution and truthful recovery

At the start of `runTakeover`, discard the stale normal-run resolution and resolve again from current host state before any takeover agent or authoritative verification runs. Classify unresolved capabilities into autonomous recovery or an exact authority request, and integrate the full acceptance matrix through the real takeover/verification flow.

Expected source ownership:

- `src/orchestrator/environment-takeover.ts` (new): forced re-resolution, autonomous compatible-candidate selection, deduplication of blockers, and recovery classification.
- `src/orchestrator/machine.ts`: invoke takeover re-resolution before `options.agents.takeover` and before `attachAuthoritativeVerification`; stop truthful completion when required capabilities remain unresolved.
- `src/environment/remediation.ts` (new): pure mapping from resolution failures to either autonomous next action or the single sensitive authority request.
- `src/orchestrator/verification.ts` only for the narrow integration needed to ensure takeover verification consumes the refreshed record.

Expected test ownership:

- `tests/orchestrator-environment-takeover.test.ts` (new): real takeover sequencing, refreshed environment use, one-blocker behavior, and no misleading passed verification.
- `tests/environment-remediation.test.ts` (new): authority classification boundaries.
- `tests/orchestrator.test.ts`: regression coverage for normal takeover completion and authoritative warnings.

Required integrated simulations:

- Multiple Python versions, a broken placeholder, an off-PATH ffprobe, and helper discovery all recover autonomously when a compatible installed candidate exists; takeover and verification use the refreshed selected paths.
- A missing module with no compatible installed interpreter yields one blocker. It requests human authority only if installation is the remaining remediation; it does not install anything.
- Blocked declared network access yields one blocker naming the host. It requests human authority only when permission, credentials, or sandbox/network policy must change; transient probe failure retains truthful retry guidance and does not fake success.
- A missing helper searches already-installed compatible locations autonomously. It requests authority only if installation or sandbox/permission change is required.
- Credential absence and sandbox denial are separately classified and never generalized into permission to weaken security.
- In every unavailable-capability case, authoritative verification is not marked passed and the user sees one diagnostic containing the exact capability, attempted sources, and allowed recovery action.

Independent verification:

- `npm test -- tests/orchestrator-environment-takeover.test.ts tests/environment-remediation.test.ts tests/orchestrator.test.ts`
- `npm run typecheck`
- `git diff --check`
- `authoritative-only: npm test`

The candidate checks only Step 3 complete in this plan. Completion of Step 3 completes W0027.

## Authority boundary

Ordinary discovery, probing, selection, path logging, propagation, takeover re-resolution, bounded retries, and use of already-installed compatible runtimes require no human intervention. Stop at a human authority gate only when the next effective action would install a dependency or runtime, obtain or change credentials, grant task-required network access, or alter/weakening sandbox or filesystem permissions. The blocker must name that exact action; approval for one action grants no broader authority.

## Plan-candidate verification

This planning turn changes only `process/reciprocal/epics/W0027-plan.md` and implements no product source or tests.

- `npm run typecheck`
- `git diff --check`
- `authoritative-only: npm test`
