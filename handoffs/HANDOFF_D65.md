# Handoff D65 (structural: visual JUDGMENT must stay with the leader, never delegated to the worker)

## What happened (real, live evidence — general workflow issue, not specific to any one project)
A leader (`claude-code/cli`, vision-capable) planned a video-quality-verification project under
D60's `perceptualVerificationRule`. The plan correctly required extracting sample frames and
computing objective pacing metrics — but then assigned the actual VISUAL INSPECTION of those
frames as a worker build task (plan task "T3: vision inspection"). The configured worker
(`minimax/minimax-m3`) has no vision capability. The worker correctly declined to guess ("Per the
system prompt hard rule, this requires a blocked CompletionReport") rather than fabricate a
verdict — the existing blind-worker-never-guess safeguard worked exactly as designed. But the
consequence is that no one competent to judge the frames ever actually looked at them; the round
ended blocked instead of actually verifying quality.

## Root cause
`perceptualVerificationRule` (`src/agents/leader.ts`, from D60) says work must "produce concrete,
inspectable evidence (sample frame/screenshot files...)" during planning, and says to "actually
inspect representative real evidence" before approving — but never says WHO does the inspecting.
Read literally, a leader can satisfy "produce inspectable evidence" by writing a worker task that
extracts frames AND is written as though the worker will also visually judge them, since nothing
distinguishes "mechanical extraction" (any worker can do this) from "visual judgment" (requires
vision, and the worker configured for a given session may not have it).

The pre-existing `workerMediaWarning` mechanism (checked — only wired into the AI-SDK leader path
in `src/agents/live.ts`, not `codex-cli`/`claude-code-cli` leader.ts at all) doesn't cover this
either: it only warns about media the user attached at request time, not media the plan itself
generates mid-task (a rendered video didn't exist as an attachment — it's a deliverable the plan
produces).

## D65-1: Split "produce evidence" from "judge evidence" explicitly in the shared rule
Amend `perceptualVerificationRule` in `src/agents/leader.ts` (or add a short adjacent rule
threaded the same way, your call on which reads cleaner) to make the division of labor explicit:
- Frame/screenshot EXTRACTION (a mechanical ffmpeg/screenshot step, no vision required) may be a
  worker task.
- The actual VISUAL JUDGMENT of that evidence — does this frame look right, is text legible, is
  anything corrupted — is the LEADER's responsibility during review/takeover, using its own
  vision tool. Do not write a BuildPlan task that requires the WORKER to view, judge, or interpret
  image/video content. If a plan needs visual verification, the worker's task is only to produce
  the raw evidence files; the leader inspects them itself in the following review round.
- This applies regardless of whether the configured worker happens to have vision capability —
  keep the judgment step with the leader consistently, since worker/leader model choice can change
  between sessions and the rule shouldn't depend on which worker happens to be configured.

Suggested addition (adapt wording to fit alongside the existing rule text, don't just append
awkwardly):
```
Producing evidence and judging it are different jobs. Extracting frames or screenshots is a
mechanical step and may be a worker task. Actually looking at them and judging whether they are
correct is not — that stays with you (the leader), during review or takeover, using your own
vision tool. Never write a BuildPlan task that requires the worker to view or judge image/video
content; the worker's job is only to produce the raw evidence files.
```

## D65-2: Regression coverage
Add a presence/wiring test (same style as the existing `leader-rules.test.ts` D60/D61 tests)
confirming the new text is present in `leaderPlannerPrompt` at minimum (this is where the
mis-assignment actually happens — during planning). Also fine to include in reviewer/takeover
prompts for consistency, matching how `perceptualVerificationRule` itself is already threaded.

## Acceptance
tsc + `npm test` green, new presence test passes. Live check (optional but valuable if cheap): a
small real planning call for a task with a visual deliverable, confirming the resulting plan's
worker-facing tasks don't require the worker to judge images — only to produce them. Commit
`D65-<n>:`, create `D65_done.txt`.
