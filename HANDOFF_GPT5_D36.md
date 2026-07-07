# Handoff to GPT-5 — Round D36 (Codex CLI as a selectable leader/worker engine)

User request: use OpenAI Codex CLI itself — not just "a GPT model via API key" — as the leader
and/or worker engine in Tandem. This is architecturally different from every existing model
integration: Codex CLI is a full agentic tool with its own tool-loop, sandboxing, and auth (a
ChatGPT-plan or its own API-key login, managed entirely by Codex itself — Tandem must NEVER read
or touch `~/.codex/auth.json`; that was explicitly ruled out earlier this session and remains
off-limits). Codex runs as a subprocess Tandem shells out to, not a `LanguageModel` the AI SDK
calls.

## Facts verified live this session (reviewer ran these — do not re-derive, trust and build on them)

- Installed at (Windows, this machine — DO NOT hardcode; must be discovered, see D36-1):
  `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe` — the `<hash>` segment changes per
  install/update. `codex`/`codex.exe` is NOT on PATH by default.
- Version: `codex-cli 0.142.5`.
- `codex exec [OPTIONS] [PROMPT]` is the non-interactive entry point. Key flags:
  - `-C, --cd <DIR>` — working root (maps to Tandem's `projectDir`).
  - `-s, --sandbox <read-only|workspace-write|danger-full-access>` — governs whether the
    model's own shell/file tools may write. This is the ONLY access-control knob in `exec` mode.
  - `-a`/`--ask-for-approval` is a TOP-LEVEL-only flag; `codex exec` does not accept it and
    always runs with `approval: never` (confirmed live) — there is no interactive escalation
    possible in headless mode. This is a hard constraint, not an oversight to work around.
  - `--output-schema <FILE>` — path to a JSON Schema file constraining the agent's final
    response shape.
  - `-o, --output-last-message <FILE>` — writes ONLY that final schema-conformant response to a
    file. Verified live: asked for `{"answer":"4"}` per a 3-property test schema, got back
    exactly `{"answer":"4"}` in both stdout and the output file. This is the artifact contract —
    reuse Tandem's existing zod schemas, converted to JSON Schema (see D36-3).
  - `--json` — JSONL event stream on stdout. Verified live shape:
    ```
    {"type":"thread.started","thread_id":"..."}
    {"type":"turn.started"}
    {"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"...","aggregated_output":"","exit_code":null,"status":"in_progress"}}
    {"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"...","exit_code":0,"status":"completed"}}
    {"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"done"}}
    {"type":"turn.completed","usage":{"input_tokens":24680,"cached_input_tokens":21760,"output_tokens":51,"reasoning_output_tokens":0}}
    ```
    `item.*` events with `type: "command_execution"` map directly onto the D23 activity-strip
    and tool-trace transcript lines; `agent_message` items feed streaming text; `turn.completed`
    carries REAL per-turn token usage — wire this into CostLedger, do not fake it as $0.
    Treat unrecognized `item.type` values generically (log as activity, don't crash) since Codex
    may add item types in future versions.
  - `--ephemeral` — don't persist Codex's own session files (use this for every Tandem-triggered
    invocation so Tandem-driven rounds don't clutter the user's own `~/.codex/sessions`).
  - `--skip-git-repo-check` — required since not every Tandem projectDir is a git repo.
  - `-m, --model <MODEL>` — optional override of Codex's own default model.
  - Default model observed live: `gpt-5.5`, `provider: openai`. Do not assume this is fixed;
    read it from Codex's own banner/config rather than hardcoding.
  - When invoking via Node's `child_process`, explicitly set stdin to `"ignore"` (the CLI reads
    from stdin if attached/piped — "Reading additional input from stdin..." was observed even
    when not intended; do not let it hang waiting on an inherited stdin in a GUI process).

## D36-1: Codex binary discovery
New module `src/agents/codex-cli/locate.ts`:
- Try `codex` then `codex.exe` on PATH first (covers non-Windows-Store installs, e.g. future
  npm-global installs).
- Windows fallback: glob `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`, pick the newest by
  mtime if multiple.
- Config override: `codexCliPath` in `.tandem/config.json` (and a `CODEX_CLI_PATH` env var),
  checked first if present.
- Cache the resolved path for the process lifetime (don't re-glob per call).
- A lightweight readiness check for `/models` and the dropdowns: resolve the path and run
  `codex --version` (cheap, no auth touched); report "ok"/"missing" — do NOT read
  `~/.codex/auth.json` to determine "ok" status; a version-check success is sufficient signal
  that Codex is installed (auth failures surface naturally as a failed `exec` call at run time,
  surfaced as a normal SYSTEM error like any other provider failure).
Unit tests: PATH-found case, glob-fallback case (fake fs), override-path case, newest-wins when
multiple hash dirs exist (mock).

## D36-2: Registry entry
Add `provider: "codex-cli"` to `ModelEntry`/`CustomModel` unions (schema.ts, registry.ts).
Built-in entry: `id: "codex/cli"`, `provider: "codex-cli"`, no `envKey` required (auth is
Codex's own business), `modelName` optional (passthrough to `-m` if set). `validateModelEnv`
must special-case this provider to skip the "missing env var" check and instead check binary
resolution (D36-1). `/models` and the model dropdowns show `codex/cli` as available once the
binary is found, independent of any Tandem `.env` keys.

## D36-3: Schema conversion helper
`src/agents/codex-cli/schema-json.ts`: hand-written (or minimal, no-new-dependency) converters
from `BuildPlanSchema` / (a triage-combined schema, see D36-5) / `CompletionReportSchema` /
`ReviewVerdictSchema` / the takeover `{report, userSummary}` shape into plain JSON Schema files
written to a temp path per invocation (clean up after). Keep this hand-rolled and matched
exactly to the existing zod shapes rather than adding a `zod-to-json-schema` dependency, unless
you judge the hand-rolled version becomes unmaintainable — if so, justify the dependency
addition in the completion report.

## D36-4: Worker integration (`src/agents/codex-cli/worker.ts`)
Implements the `build` arm of `AgentFns` when `config.worker` resolves to `codex-cli`:
- Before invoking anything: `assertSafeProjectDir(cwd)` — REUSE the existing D13 self-protection
  guard verbatim. This is non-negotiable; Codex's own tools bypass Tandem's tool layer entirely,
  so Tandem's outer guard is the only thing standing between a Codex-backed round and Tandem's
  own install / `~/.tandem`.
- Build the prompt from the same content `buildWorkerContext()` already produces (plan, round,
  feedback, previous report summary) — reuse that function, do not duplicate its budget logic.
- Spawn `codex exec -C <cwd> -s <sandbox> --skip-git-repo-check --ephemeral --json
  --output-schema <tmp CompletionReportSchema.json> --output-last-message <tmp file> <prompt>`
  with stdin `"ignore"`.
- Sandbox mapping from Tandem's `permissionMode`: `auto-edit`/`yolo` → `workspace-write` (yolo
  may additionally consider `danger-full-access` — default to `workspace-write` unless you can
  justify full-access is needed; keep it conservative). `ask` mode: since `exec` cannot ask
  per-command, do not attempt to fake it — instead, when `permissionMode === "ask"` and the
  worker is Codex-backed, gate with ONE confirmation before the whole round starts (reuse the
  existing plan-confirmation modal pattern: "Run this round via Codex CLI with write access?
  Codex cannot prompt per-command in this mode.") rather than silently downgrading or silently
  escalating.
- Parse `--json` stdout line-by-line; route `command_execution`/other item types through the
  existing `onToolEvent` callback (role "worker"); route `agent_message` item text through
  `onWorkerText`. On `turn.completed`, call `ledger.add("worker", codexEntry, usage.input_tokens
  + (usage.cached_input_tokens ?? 0 accounted per existing cache-cost conventions if any —
  otherwise just input_tokens), usage.output_tokens + usage.reasoning_output_tokens)`. Since
  Codex's OWN billing (ChatGPT plan) may not map to per-token $ pricing at all, `costHints` for
  `codex/cli` should be OMITTED by default (shows $0, same honest-omission pattern used for the
  unpriced Gemini 3.x models) unless the user supplies their own via `customModels`.
  ADD A CLEAR NOTE in the cost line/tooltip: "billed via your Codex CLI account, not by token
  price" when costHints are absent for this entry.
- Read `--output-last-message`'s file, `JSON.parse`, run through the EXISTING
  `validateCompletionReport` (same enforcement, same verification-command checking as every
  other worker) — do not create a parallel, looser validation path.
- Clean up temp schema/output files after each call (success or failure).

## D36-5: Leader integration (`src/agents/codex-cli/leader.ts`)
Implements `plan` / `review` / `takeover` when `config.leader` resolves to `codex-cli`.
- Same `assertSafeProjectDir` guard before every invocation, including review/takeover (defense
  in depth, matches the worker path).
- **Planning + triage in one call** (do not run two separate Codex invocations — each is a full
  billed agent turn): define a combined schema
  `{ kind: "question" | "implementation", answer?: string, plan?: BuildPlanSchema-shape }`
  (rely on JSON Schema's `oneOf`/conditional shape, or simpler: both fields optional, validate
  post-hoc in TS that exactly one is present per `kind`). Prompt instructs Codex, mirroring the
  D34/D35 triage rubric verbatim: classify first; if question, inspect files/images itself with
  its own tools and answer directly; if implementation, produce a BuildPlan. Sandbox for
  planning should default to `read-only` (the leader should not need write access to plan) —
  use `workspace-write` only if experience shows Codex needs it to inspect certain content types
  (state which you chose and why).
- Review / takeover: same one-shot `--output-schema` pattern against `ReviewVerdictSchema` /
  the takeover `{report, userSummary}` shape, with the existing prompts (leaderReviewerPrompt /
  leaderTakeoverPrompt) as the base instructions plus the plan/report/diff content exactly as
  the AI-SDK leader path assembles it today (reuse, don't reinvent).
- Cost/activity wiring identical to D36-4 (usage from `turn.completed`, tool events from
  `item.*`, role "leader").
- Conversation continuity (D30's persistent leader thread): a Codex-backed leader does NOT
  participate in the AI-SDK `leaderThread` mechanism (it has no concept of that message array).
  Instead, pass the same `history`/thread-derived text digest (the D28 conversation history
  formatter, `buildConversationHistory`) as a "Conversation so far" block in the prompt, every
  call — for a Codex-backed leader this digest is NOT redundant (there is no persistent thread
  to deduplicate against), so the D31 "skip digest when thread present" rule does NOT apply
  here. State this explicitly in code comments to avoid a future round "fixing" it incorrectly.

## D36-6: Mixed leader/worker is a first-class case
Leader and worker are resolved and invoked completely independently already (`createLiveAgents`
builds both `leader`/`worker` `ModelResolution`s separately) — verify the codex-cli branch
slots in per-role without assuming both roles use it together. Explicit test: Gemini leader +
Codex-cli worker, and Codex-cli leader + MiniMax worker, both must work.

## D36-7: UI
- `codex/cli` appears in both Leader and Worker dropdowns once the binary is found (D36-1).
- Cost display for this entry shows the "billed via your Codex CLI account" note (D36-4) when
  costHints are absent.
- If the user selects Codex for a role while `permissionMode === "ask"`, show the one-time
  round-start confirmation described in D36-4 (not a per-command prompt — explain this
  limitation in the confirmation copy itself so it isn't mistaken for a bug later).

## Testing discipline
Do NOT spawn real `codex.exe` in `npm test`. Unit-test the pure pieces: path resolution (fake
fs), argv-building (given config+prompt+sandbox, assert the exact argv array — snapshot test),
`--json` line parsing (feed the exact JSONL sample captured above as fixture text), output-file
parsing + validation (fixture files matching/violating each schema). A live smoke test may be
added as `RUN_LIVE_CODEX=1`-gated (separate from the existing `RUN_LIVE` API-based smoke test,
since this one costs Codex CLI usage, not Tandem API keys) — never run automatically.

## Acceptance
tsc + `npm test` green; commits `D36-<n>:`. Reviewer will live-test in a scratch folder (will
run `codex exec` invocations personally — has already verified the CLI itself works, will now
verify Tandem's wiring): Codex-cli as worker builds a trivial file via a Gemini-planned round;
Codex-cli as leader answers a direct question (triage: question, no plan) and separately plans
a trivial build for a Gemini worker; cost ledger shows non-zero real usage tokens for the
Codex-backed role in both directions; self-protection guard refuses a Codex-backed round
pointed at Tandem's own repo, exactly like every other engine.
