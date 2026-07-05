# Tandem

Tandem is a terminal AI coding agent with a leader/worker loop. The leader plans and reviews; the worker implements, verifies, and reports back.

## Install

```bash
npm install
npm run build
npx tandem --version
```

Copy `.env.example` to `.env` and add keys for the models you select.

```bash
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
MINIMAX_API_KEY=...
```

Project config lives in `.tandem/config.json` and overrides `~/.tandem/config.json`.

```json
{
  "leader": "google/gemini-2.5-pro",
  "worker": "minimax/minimax-m2.7",
  "maxReviewRounds": 3,
  "permissionMode": "ask",
  "maxStepsPerAgentTurn": 60,
  "customModels": [
    {
      "id": "minimax/minimax-m2.7",
      "baseURL": "https://api.minimax.io/v1",
      "apiKeyEnv": "MINIMAX_API_KEY",
      "modelName": "MiniMax-M2.7"
    }
  ]
}
```

Built-in model ids include `anthropic/claude-fable-5`, `anthropic/claude-opus-4-8`, `anthropic/claude-sonnet-5`, `anthropic/claude-haiku-4-5`, `google/gemini-2.5-pro`, `google/gemini-2.5-flash`, `openai/gpt-5`, and `openai/gpt-5-mini`.

## How A Request Flows

1. The leader reads the project and either answers directly or submits a `BuildPlan`.
2. In `ask` mode, you confirm the plan before any build starts.
3. The worker receives a fresh context with the plan, edits files, runs every verification command, and submits a `CompletionReport`.
4. The leader reviews the report plus the diff, then approves, requests another worker round, or takes over.
5. Tandem records transcript events, checkpoints, cost ticks, and artifacts in `~/.tandem/sessions/...` so `/resume <id>` can restore and continue an interrupted run.

## Commands

Run `tandem` in a TTY for the Ink interface. Non-TTY mode supports slash commands such as:

```bash
npx tandem /help
npx tandem /models
npx tandem /status
```

Supported commands: `/help`, `/models`, `/model`, `/model leader <id>`, `/model worker <id>`, `/rounds <n>`, `/status`, `/cost`, `/takeover`, `/goal add <text>`, `/goal list`, `/goal done <n>`, `/loop <interval> <prompt>`, `/loop stop`, `/schedule "<cron>" <prompt>`, `/schedule list`, `/schedule rm <id>`, `/sessions`, `/resume <id>`, `/clear`.

Bare `/model` opens a minimal picker in the TUI: choose leader or worker, then choose a model. Entries marked `ok` have their API key configured; entries marked `key` need the shown env var.

Schedules run only while Tandem is open.

## Desktop App

Tandem also ships as an Electron desktop app with a chat pane, artifact cards, model dropdowns, project picker, sessions, goals, and schedules.

```bash
npm run dev:app
```

Build the Windows installer and portable executable with:

```bash
npm run dist:app
```

The installer uses product name `Tandem` and creates its own desktop and Start Menu shortcuts. The packaged app reads the selected project folder's `.env` and `.tandem/config.json`, just like the CLI.

## Verification

Offline checks do not call provider APIs:

```bash
npx tsc --noEmit
npm test
```

The live smoke test costs real API tokens and requires `.env` keys for the configured leader and worker:

```bash
RUN_LIVE=1 npx vitest run tests/live-smoke.test.ts
```

## Demo

With real provider keys configured, run `tandem` and ask:

```text
build a CLI todo app with add/list/done commands and unit tests, in ./demo-todo
```

Set `"maxReviewRounds": 0` in `.tandem/config.json` to exercise the immediate takeover path.
