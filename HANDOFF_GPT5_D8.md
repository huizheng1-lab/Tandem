# Handoff to GPT-5 — Round D8 (expose auto-approve in the GUI)

Context: D7 APPROVED (39 tests). User request: in the desktop app, offer auto-approval as an
option alongside the ask-permission flow. The core already implements this — `permissionMode` in
`src/config/schema.ts` supports `"ask" | "auto-edit" | "yolo"` and the tool layer honors it —
the GUI just never exposes it.

## D8-1: Permission-mode selector in the top bar
Add a third dropdown (or segmented control) next to the leader/worker model dropdowns:
- **Ask** (`ask`) — prompt for every file write/edit and shell command (current behavior)
- **Auto-edit** (`auto-edit`) — file edits auto-approved; shell commands still prompt
- **Auto** (`yolo`) — everything auto-approved (destructive-command denylist still applies)
Label it "Permissions". Persist via the existing `config:set` IPC (it lands in the project's
`.tandem/config.json` through `saveProjectConfig`), take effect on the NEXT run (or immediately
if the service re-reads config per run — state which in the report). Show the active mode in the
session-start SYSTEM line alongside the models (extend D7-3's line).

## D8-2: "Always allow" escalation inside the permission dialog
In the permission modal, alongside Allow / Deny, add:
- "Allow all edits this session" — auto-approves subsequent write/edit requests in-memory
  (session-scoped, not persisted)
- "Allow everything this session" — auto-approves all subsequent requests in-memory
These do NOT change the persisted permissionMode; they only set flags in the renderer/service
for the current session. A small "auto-approving: edits/all" indicator should appear near the
phase chip while active, with an "x" to revoke.

## Guardrails (keep)
The destructive-command denylist in `src/tools/permissions.ts` must remain active in every mode —
verify with the existing tests. Do not add a way to disable it from the UI.

## Acceptance
tsc + `npm test` green (add a service/renderer test for the session-scoped auto-approve flags);
commits `D8-<n>:`; reviewer relaunches and verifies: ask-mode prompts appear; switching to Auto
runs the same prompt with zero dialogs; the session-scoped "allow all edits" suppresses edit
prompts but not bash prompts.
