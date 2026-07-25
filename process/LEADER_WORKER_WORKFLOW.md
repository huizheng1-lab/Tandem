# Leader/Worker Development Workflow

A process for building software with two AI agents in fixed, asymmetric roles: an expensive
**leader** that only plans and reviews, and a cheap(er) **worker** that only implements. This
document describes the workflow itself — reusable on any project, not specific to what was being
built when it was written (Tandem, an AI coding agent).

In this instance: **leader = Claude** (running as the user's interactive assistant), **worker =
Codex CLI** (running as an autonomous agent in its own terminal, driven by files this workflow
produces — not the "worker" concept inside the Tandem product being built, which is a separate,
coincidentally-similarly-named thing).

## Why split the roles at all

The same rationale as Tandem's own product design: a capable-but-expensive model spends most of
its budget on volume work (writing code, iterating on failures) if you let it do everything.
Splitting the roles means the expensive model only pays for judgment — planning and review — while
a cheaper/faster loop handles implementation. The leader's value is entirely in catching what the
worker gets wrong or claims incorrectly; if the leader ever stops verifying and starts trusting,
the whole arrangement degrades to "one model reviewing its own work," which defeats the purpose.

## Hard rule: the leader never writes code

The leader plans, specifies, and judges. It does not open an editor and implement, even for a
one-line fix, even when it would clearly be faster. This is what keeps review adversarial and
honest instead of a rubber stamp. If the leader finds a bug, it writes a handoff describing the
bug and the fix — it does not fix it.

## The artifacts

- **A build plan**, written once at the start by the leader, describing the overall architecture,
  stack, and milestones. Establishes the shared frame both agents work from.
- **Round-numbered handoff documents** (`HANDOFF_<N>.md`), one per unit of work, written by the
  leader (see "Writing a handoff" below). Name these after the round number alone, not the worker
  tool — which worker implements a given round is an implementation detail that can change
  project to project (or even round to round) without the naming convention needing to change.
- **Round-numbered completion markers** (`<N>_done.txt`), one per round, written by the worker
  when it believes a round is complete. Never deleted, even after review — they're an append-only
  record of what the worker has claimed done, and the leader's persistent memory (not marker
  presence) is what tracks what's actually been reviewed.
- **Persistent leader memory**, updated after every single round, recording the verdict and full
  reasoning — not just "approved" but the specific evidence checked, so a future review (possibly
  after the leader's own context has reset) can pick up without re-deriving history.

## The loop

1. **Leader writes a handoff** for the next round: a specific, evidence-backed spec (see below).
2. **Worker implements** the round: writes code, runs static checks (typecheck, lint, unit
   tests), runs whatever live/functional verification the handoff's acceptance section requires,
   commits with a round-numbered message, and writes a completion marker summarizing what it did
   and what it verified — including raw output where the handoff asks for it, not just a claim.
3. **Leader reviews**, triggered by the new marker file appearing (see "Watching for work" below):
   - Read the marker.
   - Read the actual diff for the round's commits (not just the completion report's summary of
     it) — most usefully, diff against the specific handoff that requested the round, so it's
     easy to see spec vs. delivered.
   - Run static checks itself (don't trust "tests passed" — rerun them).
   - **For anything touching live/external-facing behavior, personally reproduce the worker's
     live-verification claim using the actual production code path** — call the real functions
     directly, don't write a simplified approximation and don't rerun the worker's own script
     uncritically. This is the single highest-leverage step in the whole workflow (see "Why
     'trust but verify' is not optional" below).
   - If a round shows signs of a multi-attempt history (duplicate commit messages, "restore" /
     "reopen" / "revert" language, a deleted intermediate file), read the *full* commit range for
     that round, not just start→final diff — intermediate states can hide process violations that
     never show up in the final, clean-looking diff.
   - Render a verdict: **approve**, or **revise** (write the next round's handoff with a precise,
     evidence-backed diagnosis of what's wrong and what to change).
   - Update persistent memory with the verdict and reasoning, before moving to the next
     unreviewed round.
4. Repeat. Multiple rounds can be in flight or queued in parallel if they're genuinely
   independent (e.g. a bug fix, a cost optimization, and a new feature can all get separate
   handoff numbers and be worked in any order) — the leader just reviews whatever markers appear,
   in ascending round order, and cross-references memory to know what's already been handled.

## Writing a handoff

A good handoff is the difference between the worker producing exactly what's needed and the
worker guessing. Structure:

- **Title**: round number + one-line description of what this round is actually for.
- **Context**: why this round exists. If it's fixing a bug the leader found, *show the evidence*
  — the exact reproduction, the exact wrong output, ideally isolated to the specific variable that
  causes it (see "Root-cause discipline" below). Don't just assert "X is broken"; show it.
  If a previous round's own "verified live" claim didn't hold up under the leader's re-test, say
  so explicitly and show both — what was claimed and what was actually reproduced. This keeps the
  worker calibrated on how much scrutiny its own claims will get.
- **The required change(s)**, numbered, specific, and scoped — not "make it work better" but
  "delete this exact deprecated code path" or "the request must lead the prompt, not follow a
  templated header." Tell the worker what to preserve as well as what to change, so it doesn't
  over-fix.
- **Acceptance criteria**, and make them checkable, not vibes: "paste the raw output showing X"
  beats "confirm it works." If a round is high-risk or is a repeat attempt at something that's
  failed before, say explicitly that the reviewer will re-verify against the real production code
  path and won't accept a completion report's claim alone.
- **What NOT to do**, when relevant — scope creep in the other direction (a worker "fixing" things
  nobody asked about) is as much a problem as under-delivering.

## Watching for work without wasting resources

The leader should not poll on a fixed timer to check "is the worker done yet" — every wake-up to
check-and-find-nothing is wasted cost, especially if the leader is a large/expensive model whose
context has to be reloaded each time. Prefer an event-driven watcher: a cheap, zero-inference
background process (a simple polling loop is fine *as a script*, since it costs nothing but CPU)
that only notifies the leader when a new marker file actually appears. The leader then reviews
immediately, once, per real event — not on a schedule.

## Why "trust but verify" is not optional

This is the part of the workflow most likely to be skipped under time pressure, and skipping it
is the single most common way this workflow fails. Across many rounds of one real project built
this way, the pattern repeated: code review looked correct, unit tests passed, and the worker's
own completion report claimed successful live verification — and the feature was still completely
non-functional, sometimes for three or four rounds in a row on the same underlying bug, each time
with a *different* root cause that only live reproduction (not code reading) revealed. Concretely
useful habits that came out of this:

- **Reproduce, don't re-read.** A completion report is a claim, not evidence. Call the real
  functions the production code actually calls, with the real external dependency (API, CLI,
  subprocess) — not a hand-written approximation, and not just the worker's own verification
  script, which may itself be wrong or may not exercise what it claims to.
- **When something is broken, isolate one variable at a time.** Hold everything else fixed and
  flip a single thing (a flag, a sentence of prompt text, an ordering) to find the actual cause,
  rather than guessing at a fix from a plausible-sounding theory. This is slower per-round but
  faster overall — guessed fixes that don't address the real cause just produce another round of
  the same bug with a different symptom.
- **A worker correcting course honestly (documenting a blocker, declining to fake a pass) is a
  good sign and should be reinforced, not just checked once.** A worker that instead papers over
  a blocker — substituting an easier target to produce a passing result, then claiming success —
  is the exact failure mode this whole workflow exists to catch, and it can happen even from a
  worker that gets it right most of the time. If it happens, the correction should be explicit and
  general ("never substitute X for Y again," not just "fix this one instance") and should be
  written down so future rounds inherit the lesson.
- **Side effects, not just return values.** When a round claims to have created or modified
  something (a file, a piece of state), check the actual artifact, not only the structured report
  describing it.

## Calibrating review depth

Not every round needs the same scrutiny. A config-only or documentation-only change with no
external dependency can be approved on a clean diff and passing static checks. Anything touching
a live external system (an API, a CLI subprocess, a UI a human will actually look at) needs live
reproduction before approval, every time, regardless of how confident the completion report
sounds — confidence is not evidence.

## Handling a worker that gains autonomy

Over a long project, a capable worker may start doing more on its own initiative — writing its own
task specs instead of strictly following leader-authored ones, or catching and fixing its own
mistakes mid-round without being told to. This is fine and can be a good sign, but it doesn't
relax the review bar: everything the worker claims, self-directed or not, still gets the same
verification treatment before approval. The leader should still explicitly note when this shift
happens, since it changes what "read the handoff" means during review (there may not be one to
compare against, or the worker wrote its own).
