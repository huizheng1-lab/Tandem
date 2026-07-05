# TANDEM — Leader/Worker AI Coding Agent: Build Plan

**Document status:** Build plan authored by the lead architect (Claude Fable 5). This document is the
complete specification handed to the implementing agent (you). Follow it milestone by milestone.
When all milestones pass their acceptance criteria, report completion; the plan author will review
the result and either approve or return revision instructions.

---

## 1. What we are building

**Tandem** is a terminal-based AI coding agent (Claude Code–style chat TUI) with a two-tier agent
architecture:

- **Leader** — a high-capability model (e.g. Claude Fable 5 / Opus). Talks to the user, plans work,
  writes build plans, reviews the worker's output, decides when the job is done, and takes over
  implementation if the worker fails repeatedly.
- **Worker** — a cheaper capable coding model (e.g. MiniMax M2.x, GPT-4o-mini class). Receives the
  leader's build plan, implements it with full tool access (read/write/edit/bash), self-verifies
  (build passes, tests pass, plan followed), and reports back.

**Core loop:**

```
User request
   → Leader: clarify (if needed) + produce BuildPlan
   → Worker: implement plan, self-verify, produce CompletionReport
   → Leader: review diff + report against acceptance criteria
       ├─ APPROVE  → Leader summarizes to user, done
       ├─ REVISE   → Leader sends ReviewFeedback, worker iterates (round++)
       └─ round > maxRounds → TAKEOVER: Leader implements the remainder itself, then reports
```

The user chooses which model is leader and which is worker. API keys live in `.env`. Long-horizon
features: `/goal`, `/loop`, `/schedule`.

### Relationship to opencode (github.com/anomalyco/opencode)

Use opencode as a **reference for UX and patterns only** — do NOT fork it. Rationale: it is a very
large monorepo, and the leader/worker orchestration must live at the heart of the agent loop, which
would mean invasive surgery on unfamiliar code. Building fresh from this spec is faster and yields
a codebase the leader can review effectively. Borrow from opencode:

- The chat TUI layout: scrollback transcript, input box at the bottom, status line.
- The idea of named agent modes visible in the UI (opencode has "plan"/"build"; we have
  LEADER/WORKER badges on messages).
- JSON config file + `.env` keys for multi-provider setup.

---

## 2. Tech stack (fixed — do not substitute)

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node.js ≥ 20, TypeScript 5.x, ESM | `"type": "module"` |
| TUI | **Ink 5** (+ `ink-text-input`, `ink-spinner`) | React-for-terminal, same family as Claude Code's UI |
| LLM providers | **Vercel AI SDK v5** (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/openai-compatible`) | One `streamText` interface for all models; MiniMax/DeepSeek/etc. go through `openai-compatible` with a custom `baseURL` |
| Schema validation | `zod` | All inter-agent artifacts and config are zod-validated |
| Shell execution | `execa` | With timeout + output capture |
| Scheduling | `node-cron` | For `/schedule` |
| Env | `dotenv` | Loads `.env` from project root, then `~/.tandem/.env` as fallback |
| Diffing | `diff` (npm) | For leader review payloads |
| Tests | `vitest` | Unit tests for orchestrator, tools, config |
| Packaging | `tsup` build, `bin` entry `tandem` | `npx tandem` / global install |

---

## 3. Repository layout

```
tandem/
├── package.json
├── tsconfig.json
├── .env.example                 # every supported key, commented
├── README.md                    # user-facing: install, config, commands
├── src/
│   ├── index.ts                 # CLI entry: parse args, load config, mount TUI
│   ├── config/
│   │   ├── schema.ts            # zod schemas for config file + env
│   │   └── load.ts              # merge: defaults ← ~/.tandem/config.json ← ./.tandem/config.json ← CLI flags
│   ├── providers/
│   │   ├── registry.ts          # model catalog: id → {provider, baseURL?, envKey, contextWindow, costHints}
│   │   └── client.ts            # makeModel(modelId) → AI SDK LanguageModel
│   ├── tools/
│   │   ├── index.ts             # tool registry (AI SDK `tool()` definitions)
│   │   ├── fs.ts                # read_file, write_file, edit_file, list_dir
│   │   ├── search.ts            # glob, grep (use fast-glob + naive content scan; no ripgrep dep)
│   │   ├── shell.ts             # bash tool via execa, permission-gated
│   │   └── permissions.ts       # permission modes + interactive approval bridge to TUI
│   ├── agents/
│   │   ├── runner.ts            # generic agent loop: streamText + tool execution + step limit
│   │   ├── leader.ts            # leader system prompts (planner, reviewer, takeover personas)
│   │   └── worker.ts            # worker system prompt (implementer persona)
│   ├── orchestrator/
│   │   ├── artifacts.ts         # zod: BuildPlan, CompletionReport, ReviewVerdict, ReviewFeedback
│   │   ├── machine.ts           # the state machine (section 5)
│   │   └── takeover.ts          # leader-takeover path
│   ├── commands/
│   │   ├── index.ts             # slash-command parser + dispatch
│   │   ├── model.ts             # /model, /models
│   │   ├── goal.ts              # /goal
│   │   ├── loop.ts              # /loop
│   │   ├── schedule.ts          # /schedule
│   │   └── misc.ts              # /help /status /rounds /takeover /clear /cost /resume
│   ├── session/
│   │   ├── store.ts             # JSONL transcript persistence, session list/resume
│   │   ├── goals.ts             # .tandem/goals.json CRUD
│   │   └── cost.ts              # token/cost accounting per role
│   └── tui/
│       ├── App.tsx              # root Ink component
│       ├── Transcript.tsx       # message list w/ role badges: USER / LEADER / WORKER / SYSTEM
│       ├── InputBar.tsx         # prompt input, slash-command autocomplete
│       ├── StatusLine.tsx       # leader model · worker model · phase · round i/N · session cost
│       ├── Approval.tsx         # y/n permission prompt overlay
│       └── PlanView.tsx         # collapsible rendering of BuildPlan / ReviewVerdict artifacts
└── tests/
    ├── orchestrator.test.ts
    ├── config.test.ts
    ├── tools.test.ts
    └── artifacts.test.ts
```

---

## 4. Configuration & model selection

### 4.1 `.env` (see `.env.example`)

```
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
MINIMAX_API_KEY=
DEEPSEEK_API_KEY=
GOOGLE_API_KEY=
# Optional overrides for OpenAI-compatible endpoints:
MINIMAX_BASE_URL=https://api.minimax.io/v1
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
```

### 4.2 Config file `.tandem/config.json` (project) merged over `~/.tandem/config.json` (global)

```jsonc
{
  "leader": "anthropic/claude-fable-5",
  "worker": "minimax/minimax-m2.7",
  "maxReviewRounds": 3,           // rounds before leader takeover
  "permissionMode": "ask",        // "ask" | "auto-edit" | "yolo"
  "maxStepsPerAgentTurn": 60,     // tool-call step cap per agent invocation
  "customModels": [               // user-added OpenAI-compatible models
    {
      "id": "minimax/minimax-m2.7",
      "baseURL": "https://api.minimax.io/v1",
      "apiKeyEnv": "MINIMAX_API_KEY",
      "modelName": "MiniMax-M2.7"
    }
  ]
}
```

### 4.3 Model registry (`providers/registry.ts`)

Ship built-in entries for: `anthropic/claude-fable-5`, `anthropic/claude-opus-4-8`,
`anthropic/claude-sonnet-5`, `anthropic/claude-haiku-4-5`, `openai/gpt-5`, `openai/gpt-5-mini`,
plus anything in `customModels`. Resolution: `customModels` → built-ins → error with a helpful
message listing available ids. Anthropic ids use `@ai-sdk/anthropic`; OpenAI ids use
`@ai-sdk/openai`; everything with a `baseURL` uses `@ai-sdk/openai-compatible`.

At startup, validate that the env key for the selected leader and worker exists; if missing, show a
clear TUI error naming the exact env var, and drop into config-repair mode rather than crashing.

---

## 5. The orchestration state machine (the heart of the product)

`orchestrator/machine.ts` implements this explicit state machine. States persist to the session so
a crash/resume lands back in the right phase.

```
IDLE → PLANNING → BUILDING → REVIEWING → (DONE | FEEDBACK → BUILDING | TAKEOVER → DONE)
```

### 5.1 PLANNING (leader)

Leader runs with **read-only tools** (read_file, list_dir, glob, grep — no write/edit/bash) plus a
`submit_build_plan` tool. System prompt: senior tech lead; explore the codebase as needed, ask the
user clarifying questions ONLY if the request is genuinely ambiguous (via a `ask_user` tool that
surfaces in the TUI), then call `submit_build_plan` with a `BuildPlan`:

```ts
const BuildPlan = z.object({
  title: z.string(),
  objective: z.string(),                       // one paragraph, restates user intent
  constraints: z.array(z.string()),            // "do not touch X", "use library Y", ...
  tasks: z.array(z.object({
    id: z.string(),                            // "T1", "T2", ...
    description: z.string(),                   // concrete, file-level where possible
    files: z.array(z.string()).optional(),     // expected touched files
  })),
  acceptanceCriteria: z.array(z.string()),     // testable statements
  verification: z.array(z.string()),           // exact shell commands: "npm test", "npx tsc --noEmit"
});
```

The plan renders in the TUI as a collapsible card. In `permissionMode: "ask"`, the user confirms
the plan (enter = proceed, or types adjustments which are fed back to the leader) before BUILDING.

### 5.2 BUILDING (worker)

Worker runs with **full tools**. Its context is constructed fresh each round (do NOT share the
leader's raw context): system prompt (implementer persona) + BuildPlan + (on round > 1) the
previous ReviewFeedback + a compact summary of its own previous round's report. The worker MUST,
before finishing: run every command in `verification[]`, fix failures, and then call
`submit_completion_report`:

```ts
const CompletionReport = z.object({
  status: z.enum(["complete", "blocked"]),
  summary: z.string(),
  taskResults: z.array(z.object({
    id: z.string(),
    status: z.enum(["done", "partial", "skipped"]),
    notes: z.string().optional(),
  })),
  filesChanged: z.array(z.string()),
  verificationResults: z.array(z.object({
    command: z.string(),
    passed: z.boolean(),
    output: z.string(),                        // tail-truncated to 2000 chars
  })),
  deviationsFromPlan: z.array(z.string()),
});
```

Enforce in the runner: the report is rejected (with an error message back into the worker's loop)
if any `verification` command from the plan is missing from `verificationResults` or reported
un-run. `status: "blocked"` is allowed and goes straight to leader review.

### 5.3 REVIEWING (leader)

Leader (reviewer persona) receives: the BuildPlan, the CompletionReport, and a **unified diff** of
all changes made during this round (snapshot working-tree state before BUILDING; if the project is
a git repo use `git diff` + `git status` for untracked files, else diff against an in-memory
before-snapshot of touched files). Leader has read-only tools + bash restricted to the plan's
verification commands (it may re-run them to check the worker's claims — do not trust the report
blindly). It ends by calling `submit_review`:

```ts
const ReviewVerdict = z.object({
  verdict: z.enum(["approve", "revise", "takeover"]),
  scores: z.object({ correctness: z.number().min(1).max(5),
                     planAdherence: z.number().min(1).max(5),
                     codeQuality: z.number().min(1).max(5) }),
  feedback: z.array(z.object({                 // required when verdict = "revise"
    issue: z.string(),
    location: z.string().optional(),           // file:line
    requiredChange: z.string(),
  })),
  userSummary: z.string(),                     // plain-language summary shown on approve/takeover-done
});
```

Routing: `approve` → DONE (userSummary shown). `revise` → increment round; if round >
`maxReviewRounds` force takeover, else back to BUILDING with feedback. `takeover` (leader may also
choose this early, e.g. worker is blocked or thrashing) → TAKEOVER.

### 5.4 TAKEOVER (leader)

Leader gets full tools, the plan, all reports/feedback history, and the current diff; persona:
"finish the job yourself." Same verification obligation as the worker. On completion → DONE with a
userSummary that states takeover happened and why.

### 5.5 Cross-cutting rules

- Every state transition emits a SYSTEM line in the transcript, e.g.
  `── round 2/3 · leader review → REVISE (3 issues) ──`.
- Token/cost accounting per role per phase; `/cost` and the status line surface it. This is the
  product's reason to exist — the user must be able to see worker-vs-leader spend.
- All artifacts are validated with zod on submission; on validation failure the error is fed back
  into the calling agent's loop (max 2 retries, then treated as agent failure → surfaces to leader
  or user respectively).
- Small-talk / pure questions ("what does this repo do?") shouldn't launch the machine: the leader
  first classifies the request via its planning turn — it may simply answer with text and never
  call `submit_build_plan`. That is a valid terminal outcome.

---

## 6. Agent runner & tools

### 6.1 Runner (`agents/runner.ts`)

One generic loop used by leader and worker: AI SDK `streamText` with `tools`, `stopWhen:
stepCountIs(maxStepsPerAgentTurn)`, streaming deltas to the TUI. Handles: tool-call execution,
permission interception, artifact-submission tools terminating the loop, provider errors
(retry ×2 with backoff on 429/5xx, then surface).

### 6.2 Tools (same definitions, role-filtered)

| Tool | Params | Notes |
|---|---|---|
| `read_file` | path, offset?, limit? | line-numbered output, 2000-line default cap |
| `write_file` | path, content | permission-gated in "ask" mode |
| `edit_file` | path, old_string, new_string, replaceAll? | exact-match; error if not unique |
| `list_dir` | path | |
| `glob` | pattern | fast-glob |
| `grep` | pattern, glob?, path? | regex over files; cap results |
| `bash` | command, timeoutMs? | execa through the user's shell; cwd = project root; permission-gated |
| `ask_user` | question | surfaces in TUI, blocks until answered (leader-only) |
| `submit_build_plan` / `submit_completion_report` / `submit_review` | per section 5 | phase-specific |

Permission modes: `ask` = prompt for write/edit/bash (allow "always allow this command prefix" like
Claude Code); `auto-edit` = file edits free, bash prompts; `yolo` = everything free. Never allow
`bash` outside project root cwd; block obviously destructive commands (`rm -rf /`, `format`, fork
bombs) with a denylist regardless of mode.

---

## 7. TUI requirements

- Single-screen chat app (Ink). Transcript with role badges: `USER`, `LEADER` (distinct color),
  `WORKER` (distinct color), `SYSTEM` (dim). Streaming text renders live; tool calls render as
  one-line dim entries (`⚒ edit_file src/foo.ts`); artifact cards (plan/report/verdict) render as
  bordered boxes, collapsed to title + counts, expandable via a keybind.
- Status line (bottom): `leader: fable-5 · worker: minimax-m2.7 · phase: BUILDING · round 1/3 · $0.42`.
- Input bar with history (↑/↓) and slash-command autocomplete on `/`.
- `Esc` interrupts the current agent turn (abort the stream, return to input, state machine pauses
  in current phase; next user message resumes or redirects).
- Graceful degradation: if not a TTY (piped), fall back to plain line output, no Ink.

---

## 8. Slash commands

| Command | Behavior |
|---|---|
| `/help` | list commands |
| `/models` | list available model ids and which have keys configured |
| `/model leader <id>` · `/model worker <id>` | switch role model (persist to project config); bare `/model` shows an interactive picker |
| `/rounds <n>` | set maxReviewRounds |
| `/status` | current phase, round, models, session id, cost |
| `/cost` | per-role token + $ breakdown for the session |
| `/takeover` | user-forced: leader takes over the current job immediately |
| `/goal add <text>` · `/goal list` · `/goal done <n>` | long-term goals stored in `.tandem/goals.json` `{id, text, createdAt, status, notes[]}`. Active goals are injected into the leader's planning prompt every run ("standing goals — factor these in"). After each DONE, the leader appends a one-line progress note to any goal it advanced. |
| `/loop <interval> <prompt>` | re-run `<prompt>` through the full leader→worker pipeline every interval (`30s`/`5m`/`2h`). Runs sequentially (never overlap; skip if previous run active). `/loop stop` cancels. Transcript shows each iteration under a SYSTEM divider. |
| `/schedule "<cron>" <prompt>` | persist `{cron, prompt, id}` in `.tandem/schedules.json`; `node-cron` fires while the app is running (document clearly: schedules run only while Tandem is open). `/schedule list`, `/schedule rm <id>`. Missed-while-closed runs: on startup, list any missed schedules and ask whether to run now. |
| `/sessions` · `/resume <id>` | list past sessions; resume restores transcript + machine state |
| `/clear` | new session |

---

## 9. Sessions, persistence, resume

- Sessions in `~/.tandem/sessions/<project-hash>/<session-id>.jsonl`: one JSON object per event
  (user msg, agent msg, tool call/result, artifact, state transition, cost tick).
- `/resume` rebuilds transcript + machine state. Agent LLM contexts are rebuilt from artifacts +
  transcript tail (last ~30 messages), not from raw provider payloads.
- Crash safety: append + fsync on every event.

---

## 10. Milestones — implement strictly in order

Each milestone ends with: `npx tsc --noEmit` clean, `npm test` green, and the milestone's manual
acceptance check done. Do not start milestone N+1 with N failing.

**M0 — Scaffold + config + providers.** package.json, tsconfig, tsup build, `.env.example`, config
load/merge with zod, model registry, `makeModel()`. Acceptance: `tandem --version` works; unit
tests prove config precedence (defaults < global < project < flags) and that a missing API key for
a selected model produces the named-env-var error.

**M1 — Single-agent chat TUI.** Ink app, transcript, input, streaming from ONE configured model
(no orchestration yet), Esc-interrupt, non-TTY fallback. Acceptance: interactive chat with any
configured model; `/model`, `/models`, `/help` work.

**M2 — Tool loop + permissions.** All section-6 tools, runner with step cap, permission prompts in
TUI, denylist. Acceptance: in a scratch project, the model can be asked to "create hello.ts and run
it" and does so end-to-end with permission prompts appearing in ask-mode.

**M3 — Orchestration.** Artifacts, state machine, leader planning (read-only) → user plan confirm
→ worker build → leader review → revise loop → takeover, round limits, per-role cost tracking,
SYSTEM transition lines, artifact cards. Acceptance: end-to-end demo — ask Tandem to "build a CLI
todo app with add/list/done commands and unit tests, in ./demo-todo" with a real leader + worker
model; observe plan card, worker rounds, review verdict, final user summary. Also: force
`maxReviewRounds: 0` and observe immediate takeover path work.

**M4 — Long-horizon commands.** `/goal` (+ injection into planning + progress notes), `/loop`,
`/schedule` (+ startup missed-run prompt), `/sessions`, `/resume`, `/status`, `/cost`, `/rounds`,
`/takeover`, `/clear`. Acceptance: goals visibly influence a subsequent plan; a `/loop 1m` prompt
fires twice sequentially; a schedule persists across restart and is listed.

**M5 — Hardening + docs.** Provider retry/backoff, artifact-validation retry loop, session crash
resume, README (install, .env setup, choosing leader/worker incl. a MiniMax M2.x
openai-compatible example, all commands), `.env.example` complete. Acceptance: kill -9 during
BUILDING then `/resume` recovers; README instructions reproduce M3's demo from a clean clone.

---

## 11. Rules for the implementing agent

1. **No stack substitutions.** If a listed library is genuinely broken/unavailable, stop and report
   the blocker in your completion report rather than silently swapping.
2. TypeScript strict mode; no `any` except at provider-SDK boundaries with a comment.
3. Keep modules under ~300 lines; the orchestrator must stay independent of the TUI (machine.ts
   must be unit-testable with mocked agents — the tests in `tests/orchestrator.test.ts` must drive
   the full state machine with fake leader/worker functions, no network).
4. Never hardcode model names outside `providers/registry.ts`.
5. All user-facing errors must say what to do next (which env var, which config field).
6. Commit per milestone with message `M<n>: <summary>` (init a git repo at M0).
7. When done, produce a `COMPLETION_REPORT.md` at repo root following the CompletionReport shape in
   section 5.2 (in markdown), including the actual output of `npx tsc --noEmit` and `npm test`,
   and a transcript snippet or recording notes of the M3 acceptance demo.

## 12. What the reviewer will check (so you can pre-verify)

- Orchestrator unit tests genuinely cover: approve path, 2×revise→approve, round-exhaustion
  takeover, leader-early takeover, worker `blocked`, artifact validation failure retry.
- Worker context isolation (fresh context per round; leader context never leaks raw worker tool
  spam — only plan/report/diff).
- Verification-command enforcement (worker cannot submit a report omitting a plan verification
  command).
- Cost accounting is per-role and plausible.
- Esc-interrupt does not corrupt machine state.
- `.env.example` + README are sufficient for a cold start.
