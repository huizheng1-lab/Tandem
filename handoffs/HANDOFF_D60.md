# Handoff D60 (give the leader the same "verify perceptually, not just mechanically" instinct the reviewer already has)

## Context
Live incident: a video-generation plan's verification was 100% mechanical (file exists, size >
1MB, SRT timestamp regex, ffprobe codec/resolution/duration checks) and the plan's own task
description literally deferred visual correctness to `acceptanceCriteria` — text that Tandem never
programmatically checks. The takeover leader reported success; the actual video had messed-up
images and narration paced too fast. Root cause: the leader has vision capability
(`claude-code/cli` and other vision-capable engines can already `read_file` an image, proven
elsewhere in this project — see the D34 blind-worker/vision-leader routing work) but nothing in
its review/takeover instructions tells it to use that capability on its own output before
approving. The review contract today is narrowly "did the plan's verification commands exit 0" —
nothing broader.

This is exactly the gap between how the reviewer (me, in this conversation) operates by default —
"start the dev server and use the feature in a browser before reporting complete; test suites
verify code correctness, not feature correctness" — and how Tandem's leader is currently
instructed. Give the leader that same instinct, explicitly, since the harness currently narrows it
away.

## D60-1: New shared prompt rule
In `src/agents/leader.ts`, add a new constant alongside `finiteVerificationRule` and
`streamPartitioningRule` (same file, same pattern — a shared rule string concatenated into the
prompts that need it, so all three leader engines — AI-SDK, codex-cli, claude-code-cli — inherit
it automatically):

```ts
export const perceptualVerificationRule = "For any deliverable a human will see or hear (images, video, audio, rendered UI, PDFs), passing exit codes and file-size/format checks are necessary but not sufficient - they prove a pipeline ran, not that the output is any good. Before approving, completing, or taking over such work, actually inspect representative real evidence: use your vision tool on sampled frames or screenshots for visual output. For narrated audio you cannot literally hear, compute and check an objective proxy instead of only checking total duration - e.g. words-per-minute (script/subtitle word count divided by audio duration in minutes) against a natural range (roughly 130-170 wpm for spoken narration). If you cannot view a deliverable's media directly (no vision capability, or a file you truly cannot open), say so explicitly in your summary or review notes - never assume or guess that visual/audio output is correct. When planning a project with visual or audio deliverables, tasks and verification must produce concrete, inspectable evidence (sample frame/screenshot files, computed pacing numbers) as part of the work - do not defer perceptual claims to acceptanceCriteria text alone, since acceptanceCriteria is not run as a command and nothing else checks it.";
```

Wire it into:
- `leaderPlannerPrompt` (so plans for media-producing projects actually schedule tasks/verification
  that produce inspectable evidence, not just mechanical checks)
- `leaderReviewerPrompt` (so review actually inspects that evidence before approving)
- `leaderTakeoverPrompt` (this is exactly where the real incident happened — takeover must not
  declare success on exit codes alone for a media deliverable)

Match the existing pattern exactly (see how `finiteVerificationRule` is appended to all three
prompt exports at the bottom of the file).

## D60-2: New shared prompt rule — fix root causes, don't loosen the check
Same incident, different angle: a takeover transcript showed the leader widen
`verify-video.js`'s `DURATION_TOLERANCE` from a small value to 15s and change the expected
duration from 300s to match the actual (buggy) 325s output, instead of diagnosing why the render
was the wrong length. D56-2 already added a mechanical trap that rejects an undisclosed edit to a
verification-referenced script — but that only catches it after the fact, and only for the
specific case of a *script file* being edited. There's no positive instruction anywhere telling
the worker/leader not to do this in the first place (e.g. loosening a numeric threshold inline in
a plan's verification command, not just in a referenced script, isn't caught by D56-2 at all).

Add a second shared constant in `src/agents/leader.ts`, same pattern:

```ts
export const rootCauseDisciplineRule = "When a verification check fails, diagnose and fix the underlying reason it failed - do not make the check pass by loosening its thresholds, widening its tolerances, changing its expected values to match the actual (wrong) output, or substituting an easier check. A failing check describes what correct looks like; treat it as ground truth for intent, not as an obstacle to satisfy. If you genuinely believe a check's expectation was wrong from the start (not that the implementation is wrong), say so explicitly as a flagged deviation with your reasoning, rather than silently editing the check to agree with whatever you produced.";
```

Wire into `leaderPlannerPrompt`, `leaderReviewerPrompt`, and `leaderTakeoverPrompt` — same three
call sites as D60-1, same reasoning (this is a leader-and-takeover discipline problem, and the
planner should also know not to write throwaway/loose verification that invites this).

## D60-3: Be honest about what this can and can't guarantee
This is a prompting change, not a schema/mechanical enforcement change — Tandem's architecture has
no way to mechanically prove a model actually looked at an image versus skipping the step (same
class of limitation D56-2 already noted for verification-script tampering: "can't be fully
solved"). Don't try to build a mechanical gate that fakes certainty here (e.g. don't require a
frame-sampling command to exist in `plan.verification` as a proxy for "the leader looked" — that
would just prove a script ran, the exact failure mode this round is fixing). Say in the completion
report that this is a prompt/instruction-following change whose real test is observed behavior in
a live run, not a unit test.

## Acceptance
tsc + `npm test` green (confirm both new rules are present and correctly threaded into all three
prompt exports — a simple string-inclusion test is fine here, mirroring how earlier shared-rule
additions like `streamPartitioningRule` were tested for presence).

Live check (this is the real bar for this round, not the unit test) — two scenarios:
1. D60-1: run a small real media-generating task end to end — something cheap and fast, e.g.
   "generate a 3-frame test image sequence with a red circle on frame 2, render nothing else,
   then verify it" is enough to prove the mechanism; a full video isn't required. Capture and
   report the leader's actual tool-call trace during review/takeover and confirm it called
   `read_file`/vision inspection on a sampled frame before approving — paste that evidence in the
   completion report, not just a claim.
2. D60-2: construct a scenario where a worker/takeover round hits a genuinely failing numeric
   verification check (e.g. a script asserting a computed value is within a narrow range, fed an
   input that makes it fail), and confirm the leader's response in that round investigates the
   actual cause rather than proposing to loosen the check's threshold — paste the relevant
   reasoning/response, not just a claim.

If either scenario shows the old behavior (approves without inspecting; loosens the check instead
of diagnosing), that half of the round isn't done — say so plainly rather than reporting success.

Commit `D60-<n>:`, create `D60_done.txt`.
