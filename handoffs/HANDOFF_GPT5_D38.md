# Handoff to GPT-5 — Round D38 (Codex worker prompt is missing instructions the AI-SDK worker has)

D37 is APPROVED — the reviewer re-ran real `codex exec` calls covering all four scenarios that
exercise the previously-broken nullable fields (`files`, `notes`, `location`) and every one
produced correct, real values through the fixed schemas. The structured-outputs defect is fully
resolved.

One separate, smaller gap surfaced during that same live run, unrelated to D37's schema fix:
the Codex-backed worker's `CompletionReport` was rejected by Tandem's (pre-existing, correct)
`enforceVerification` because the worker reported a verification command that didn't exactly
match the plan's string. Root cause: `src/agents/codex-cli/worker.ts` builds its prompt from
only `workerPrompt` (the bare string in `src/agents/worker.ts`) + `buildWorkerContext(input)` —
it never includes the extra instructions the AI-SDK worker path assembles in `live.ts` (~line
494), specifically:
- "In verificationResults[].command, repeat the BuildPlan verification command string verbatim.
  If you adapt a command for the host platform, still use the plan's original command as
  `command` and describe the adapted command plus real output in `output`."
- The host-platform prompt (`hostPlatformPrompt`).
- Project instructions (`projectInstructions()` / TANDEM.md content).
- The blind-media/never-guess rule (not exercisable via Codex today since Codex has its own
  file-viewing tools, but keep parity for when a Codex worker output DOES need to report
  "blocked" for a media-dependent task it genuinely can't complete).

## D38-1: Bring the Codex worker prompt to parity with the AI-SDK worker prompt
In `src/agents/codex-cli/worker.ts`, extend the prompt passed to `runCodexExec` to include the
same instruction set the AI-SDK worker gets (reuse `hostPlatformPrompt`, `projectInstructions`,
and the verbatim-echo line verbatim — do not paraphrase it, use the exact wording already proven
to work in `live.ts`). `CodexWorkerOptions` will need a `projectInstructions` callback threaded
through the same way `CodexLeaderOptions` already has one (see `codex-cli/leader.ts` for the
existing pattern) — wire it from `createLiveAgents` the same way the leader path already does.

## D38-2 (minor, investigate + note): stray `.git`/`.agents` left in the workspace
After the worker-build live test, the reviewer found an empty, non-functional `.git` folder
(plain `git log`/`git status` both report "not a git repository") and an empty `.agents` folder
created directly in the workspace directory (`--cd` target), not in `CODEX_HOME`/`--ephemeral`
storage. This happened with `-s workspace-write`. Investigate whether this is a Codex CLI
workspace-write side effect (e.g. an internal diff-shadow mechanism) that should be left alone,
suppressed via a flag if one exists, or cleaned up by Tandem after each round the same way the
temp schema/output files already are. Non-blocking — note findings in the completion report;
only add cleanup code if you can confirm what's creating them and that removing them is safe.

## Acceptance
tsc + `npm test` green; commit `D38-1:`. Reviewer will re-run the same worker-build live
scenario (a plan whose verification is `powershell -Command "Get-Content <file>"`) and expects
`validateCompletionReport` to succeed without needing to relax `enforceVerification` itself —
the fix is in what the worker is told, not in weakening the existing enforcement.
