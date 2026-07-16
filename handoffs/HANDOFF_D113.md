# Handoff D113 (add Fable 5 to Claude Code CLI models; commit and push the handoffs-folder migration)

Two independent user requests, bundled into one round since neither depends on the other.

## Part A: add Fable 5 to the Claude Code CLI model options in the desktop UI

### Where the list lives (already located - don't re-derive)

- `src/config/schema.ts` line ~68: `claudeCliModel: z.string().min(1).optional()` - free
  string, no change needed.
- `src/providers/cli-models.ts`: `cliModelPatch` passes any string through for
  `/model claude-cli <name>` - no change needed.
- `app/renderer/src/main.tsx` line 36: `const claudeCliModelOptions = ["haiku", "sonnet",
  "opus"] as const;` - THIS is the only hardcoded list; the desktop dropdown is built from
  it (lines ~203-208). This is the one place to change.

### A1: add the Fable option

Add Fable 5 to `claudeCliModelOptions`. BUT first verify live what string the installed
Claude Code CLI actually accepts for it - do not assume. Candidates: the alias `fable`
(matching how `sonnet`/`opus`/`haiku` work as aliases) or the full id `claude-fable-5`.
Test with a real, cheap one-shot call through the SAME invocation path Tandem uses
(`locateClaudeCli()` + the exec argv builder, or at minimum the raw CLI with the same
flags): e.g. `claude --model fable -p "Reply with exactly: ok" --output-format json` and
confirm the response envelope reports a fable-family model (the envelope includes model
info / cost fields - check what actually ran, not just that it didn't error; a CLI that
silently falls back to a default model on an unknown alias would look identical on a
happy-path smoke). If `fable` doesn't resolve, try `claude-fable-5`. Use whichever string
verifiably works as the option value.

Note: Fable 5 is Anthropic's most capable (and most expensive) model tier - noticeably
pricier than opus-tier. No guardrail needed (the user asked for it explicitly), but keep
the existing `claudeMaxBudgetUsdPerCall` cap working unchanged for it.

### A2: regression

Whatever small test coverage exists for the options list / dropdown construction (check
`tests/renderer-session-state.test.ts` and neighbors for the existing pattern), extend it
so the Fable option's presence is pinned. If the options array has no direct test today,
add a minimal one that imports the array (export it if needed) and asserts the verified
Fable string is included alongside haiku/sonnet/opus - keeps a future refactor from
silently dropping it.

## Part B: commit the handoffs-folder migration and push everything to GitHub

The GitHub repo (https://github.com/huizheng1-lab/Tandem.git, origin/master) still shows
handoff/marker files at the repo root; the user wants it organized like the local repo,
where everything lives under `handoffs/`.

### Verified current state (don't re-derive, but sanity-check before acting)

- The local handoffs-folder migration was NEVER committed: `git status` shows ~86 deleted
  root-level `D*_done.txt` / `HANDOFF_*.md` files (staged as deletions, uncommitted) plus
  ~154 untracked files under `handoffs/`.
- Additionally there are 23+ local commits on master that have never been pushed - GitHub
  is missing everything from roughly D101 onward (this Fable round's own commits will add
  to that count - push everything together at the end).

### B1: commit the migration

Stage the root-level handoff/marker deletions together with their `handoffs/` counterparts
in ONE commit so git's rename detection pairs them up (`git add handoffs/ && git add -u --
'D*_done.txt' 'HANDOFF_*.md'` or equivalent - verify with `git status` that ONLY
handoff-related paths are staged). Explicitly DO NOT sweep in the other dirty/untracked
state: `scripts/reciprocal-direction.ps1` (modified), `.reviewer-*.mjs` scratch files,
`IMPROVEMENT_SUGGESTIONS.md` - review the staged list before committing, no blanket
`git add -A`. Note that `handoffs/` also contains handoff docs for rounds that are still
open or were just written (including this one) - committing those is fine, they're part of
the folder's normal contents.

### B2: push to origin/master

Before pushing, verify `.env` is not tracked and not in any of the unpushed commits
(`git log --all --oneline -- .env` should show nothing; `git ls-files .env` empty) - this
repo's standing rule is to re-verify that before every push. Then `git push origin master`
(this will include the Fable commit(s) from Part A too - push once at the end, not twice).
Confirm after: `git log origin/master..HEAD --oneline` is empty, and the GitHub repo root
no longer lists `D*_done.txt` / `HANDOFF_GPT5_*.md` files while `handoffs/` does.

## Acceptance

tsc + `npm test` green (Part A's regression included). Paste the raw output of the live
CLI verification call from A1 showing the fable-family model actually ran (real envelope
output, not a summary). Confirm in the completion report which string was chosen and why.
The desktop dropdown shows the new option (a manual dev-app check is sufficient; note what
you observed).

For Part B: `git status` afterwards shows no remaining handoff-related deletions or
untracked handoff files (the unrelated dirty files listed above should remain untouched).
Push succeeded and `origin/master` == local `master`. State in the completion report: the
commit hash(es), the push result, and the explicit `.env` check output.

Commit `D113-<n>:` for each logical piece of work (commit - no marker without a commit, per
the standing rule), create `handoffs/D113_done.txt`.
