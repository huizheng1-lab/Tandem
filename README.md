# Tandem

Tandem is a terminal AI coding agent with a leader/worker loop. The leader plans and reviews; the worker implements and verifies.

## Install

```bash
npm install
npm run build
npx tandem --version
```

Copy `.env.example` to `.env` and add the keys for the models you select.

```bash
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
MINIMAX_API_KEY=...
```

Project config lives in `.tandem/config.json` and overrides `~/.tandem/config.json`.

```json
{
  "leader": "anthropic/claude-fable-5",
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

## Commands

Run `tandem` in a TTY for the Ink interface. Non-TTY mode supports slash commands such as:

```bash
npx tandem /help
npx tandem /models
npx tandem /status
```

Supported commands: `/help`, `/models`, `/model leader <id>`, `/model worker <id>`, `/rounds <n>`, `/status`, `/cost`, `/takeover`, `/goal add <text>`, `/goal list`, `/goal done <n>`, `/loop <interval> <prompt>`, `/loop stop`, `/schedule "<cron>" <prompt>`, `/schedule list`, `/schedule rm <id>`, `/sessions`, `/resume <id>`, `/clear`.

Schedules run only while Tandem is open.

## Verification

```bash
npx tsc --noEmit
npm test
```

## Demo

With real provider keys configured, run `tandem` and ask:

```text
build a CLI todo app with add/list/done commands and unit tests, in ./demo-todo
```

Set `"maxReviewRounds": 0` in `.tandem/config.json` to exercise the immediate takeover path.
