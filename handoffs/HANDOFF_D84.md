# Handoff D84 (URGENT: same command-line-length bug as D83, different engine — Codex CLI leader)

Actively blocking the user's real task again tonight, same project as D79/D80/D82/D83. This is
**NOT** a recurrence of D83's bug — D83's fix (moving the Claude Code CLI review prompt to stdin)
held. This is the exact same *class* of bug (Windows command-line length limit) in a completely
different, untouched code path: the **Codex CLI** leader engine.

## What's known (confirmed live, don't re-derive)

Session: `912fa9dc-7d6b-4cb9-9828-1bb817dc4181`,
`C:\Users\huizh\.tandem\sessions\48cc7d6d326e\`. Real crash, captured with a full stack trace
(machine.ts's D83-3 stack-capture addition worked exactly as intended — this is why we have it):

```
Error: spawn ENAMETOOLONG
    at ChildProcess.spawn (node:internal/child_process:441:11)
    at spawn (node:child_process:810:9)
    at withCodexSchemaFiles (...codex-cli exec path...)
    at async codexLeaderReview (...)
    at async retryArtifact (...)
```

Root cause confirmed by code read + a live reproduction tonight:

**`src/agents/codex-cli/exec.ts`** — `buildCodexExecArgv()` (line 63): `args.push(input.prompt)`.
The ENTIRE review prompt (BuildPlan JSON + CompletionReport JSON + diff — the same
multi-thousand-character content that caused D83's crash on the Claude Code CLI side) is passed
as a single raw argv element to Node's **raw `child_process.spawn`** (line 148 in the same file —
note this file does NOT use `execa` like `claude-code-cli/exec.ts` does; it uses `node:child_process`
directly). There is no stdin transport used anywhere in this file today — `stdio` is
`["ignore", "pipe", "pipe"]` (line 151), stdin is explicitly ignored.

This is structurally the identical bug D83 fixed, just never touched, because D83's handoff was
scoped only to the Claude Code CLI (`claude-code-cli/exec.ts`) engine. The Codex CLI leader engine
is a fully separate implementation and was never patched.

**The fix exists and is confirmed live tonight**: `codex exec --help` documents it explicitly:
> `[PROMPT]` — Initial instructions for the agent. If not provided as an argument (or if `-` is
> used), instructions are read from stdin.

Live-verified just now: `echo "say the word OK" | codex.exe exec -s read-only --skip-git-repo-check
--ephemeral -C <dir> -` returned a correct response, confirming `-` triggers stdin-prompt mode and
works end-to-end with this Codex build (`OpenAI Codex v0.142.5`).

## What to do

D84-1: In `src/agents/codex-cli/exec.ts`:
- `buildCodexExecArgv()`: instead of `args.push(input.prompt)`, push `"-"` as the final
  positional argument (so Codex reads the prompt from stdin). Remove `prompt` from the argv
  content itself (the function can keep the `prompt` field on its input type if useful for
  callers, but must not put its value into argv).
- `runCodexExec()`: change the `spawn()` call's `stdio` from `["ignore", "pipe", "pipe"]` to
  `["pipe", "pipe", "pipe"]`, then after spawning, write `options.prompt` to `child.stdin` and end
  it (`child.stdin.write(options.prompt); child.stdin.end();`) — mirroring how
  `claude-code-cli/exec.ts` passes `input: options.prompt` to execa (D83's fix), adapted to raw
  `child_process.spawn`'s stdin-stream API.

D84-2: Same defensive error-formatting check D83 did for the Claude Code CLI path — confirm
`runCodexExec`'s non-zero-exit error formatting (line 177: `` `Codex CLI exited with code ${code}: ...` ``)
can't itself crash on unexpected stdout/stderr shapes. It already only uses `stderr.trim()` on a
string accumulated from `"data"` events (always a string here, unlike execa's `result.stderr`
which can be `undefined`), so this is likely already safe — verify, don't just assume, and fix
only if you find a real gap.

D84-3 (small, only if trivial while in this file): the JSON schema passed via `--output-schema`
already goes through a temp file (`withCodexSchemaFiles`), so it's not part of this bug — no
action needed there, just noting it was checked and ruled out as a second source of argv length.

## Acceptance

tsc + `npm test` green. A regression test that builds a large (10,000+ character) review prompt,
asserts `buildCodexExecArgv()`'s returned argv no longer contains the prompt text at all (only
`"-"` as the final arg), and — if practical without a real Codex CLI install in CI — a test
confirming `runCodexExec` writes the prompt to the child's stdin rather than argv. Live
verification: reproduce the exact incident-shaped case (large BuildPlan + CompletionReport +
diff review prompt, same rough size as this incident) through the real `codexLeaderReview` /
`runCodexExec` path against a real Codex CLI install, confirm no `ENAMETOOLONG` and a valid
ReviewVerdict comes back. Commit `D84-<n>:`, create `D84_done.txt`.
