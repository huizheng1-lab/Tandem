# Handoff to GPT-5 — Round D47 (Claude Code CLI: the D44 "single non-interactive call" preamble is itself the bug — delete it)

D44's restructure (request-first ordering, no empty "none" placeholder sections) was the right
direction and IS confirmed correct — but the new `singleTurnPreamble` sentence prepended to every
user prompt is what's now breaking every call. This is proven with a clean, isolated live A/B
test using the real system prompt/schema/CLI flags, varying ONLY the user-prompt content:

```
D: prompt = "What is 9 times 9? Reply with only the number."
   → structured_output: {"kind":"question","answer":"81","plan":null}   SUCCESS

E: prompt = "Request: What is 9 times 9? Reply with only the number."
   → structured_output: {"kind":"question","answer":"81","plan":null}   SUCCESS

F: prompt = "This is a single non-interactive call. Act on the request below now and respond
   with ONLY the required JSON. Do not ask a clarifying question, do not acknowledge, do not
   wait for a further message.\n\nRequest: What is 9 times 9? Reply with only the number."
   → stdout: {}                                                         BROKEN
```

Same system prompt, same `--json-schema`, same `--permission-mode`, same `--model haiku`, same
everything — the ONLY variable is the preamble sentence. With it: empty/broken output (varies —
sometimes `{}`, sometimes `{"acknowledged": false}`, sometimes `{"error":"No request provided"}`,
sometimes `{"acknowledged": false, "response": "Cannot comply: no request was provided..."}`).
Without it: correct schema-conformant output every time. This was also confirmed independent of
`--permission-mode` (plan/default both fail with the preamble), independent of `--json-schema`
presence, independent of `--model`, and independent of `--system-prompt` vs `--append-system-prompt`
— ruling out every other variable GPT-5 or I had previously suspected. The preamble text itself —
ironically written specifically to STOP Claude from waiting for a follow-up turn — appears to
collide with something in Claude Code CLI's own internal handling (plausibly its turn/session
control logic, since the wording talks about "non-interactive," "do not wait for a further
message," which may be triggering an internal early-exit path) and causes it to abort without
generating real content, rather than making it act immediately as intended.

## D47-1: Delete the preamble, keep everything else from D44
In both `src/agents/claude-code-cli/leader.ts` and `src/agents/claude-code-cli/worker.ts`, remove
the `singleTurnPreamble` constant and every place it's prepended to a user prompt
(`buildClaudeLeaderPlanPrompts`, `buildClaudeLeaderReviewPrompts`, `buildClaudeLeaderTakeoverPrompts`,
`buildClaudeWorkerPrompts`). Do NOT reintroduce a reworded version of the same idea — the isolated
test above shows NO preamble of this kind is needed once the request leads and empty
conversation/goals sections are omitted (which D44 already got right and should stay). Just
delete it; let the prompt start directly with the request-first content already in place per D44
(e.g. `Request: ${input.request}${attachmentBlock}${optionalSection(...)}`), and similarly drop the
"Review task: review the completed work now..." / "Worker task: build now from this worker task
context." lead-in lines added alongside the preamble in D44 — the isolated test shows plain
content works; these lead-ins were untested extras bundled with the broken preamble and should be
removed too unless you specifically re-verify live that they're harmless (don't assume from this
handoff that they're safe — the isolated test only proved the bare request line and the
`"Request: "`-prefixed line work, not these other lead-ins).

## D47-2: Dead code cleanup (minor, bundled)
`claude-code-cli/worker.ts` still exports `buildClaudeWorkerPrompt` (singular) which concatenates
systemPrompt+prompt into ONE string and is never called anywhere in `src/` (verified via grep) —
`runClaudeWorkerBuild` correctly uses `buildClaudeWorkerPrompts` (plural). Delete the unused
singular function, or if it's kept intentionally for some external test surface, note why in the
completion report.

## Acceptance — must be proven live, real production functions, not simplified substitutes
This is the fourth attempt at essentially the same class of "Claude Code CLI doesn't act on the
task" bug (D41 escaping, D42 combined-blob, D43 empty-section templating, now D44's own preamble).
Reviewer will re-run the same 4 scenarios (leader direct question, worker build with verbatim
verification echo, leader review, Codex-leader+ClaudeCode-worker mixed) by directly calling the
real `buildClaudeLeaderPlanPrompts`/`buildClaudeWorkerPrompts`/`runClaudeExec` functions (not
hand-written approximations) and will not approve based on code review or a completion-report
claim alone — paste the literal raw stdout for at least the leader-question and worker-build
scenarios in the completion report, showing correct `structured_output` with no empty/error/
acknowledgment envelope. tsc + `npm test` green; commit `D47-<n>:`.
