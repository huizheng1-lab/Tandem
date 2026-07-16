# Handoff to GPT-5 — Round D6 (desktop app startup crash + one live-run blip)

Context: D0–D5 offline review APPROVED (core untouched except spec'd R8-1; 35 tests; scripts and
packaging config in place). R8-1 verified live (run 11: reviewer received a real diff, approved,
no takeover). But the desktop app CRASHES at startup on the user's machine: the ErrorBoundary
shows "Cannot read properties of undefined (reading 'onTextEvent')".

## D6-1: Preload bridge never loads (startup crash — do this first)
Root cause: electron-vite builds the preload as ESM (`out/preload/index.mjs`), and
`app/main/index.ts` creates the BrowserWindow with default `sandbox: true` (not set = true in
modern Electron). Sandboxed preload scripts must be CommonJS — ESM preloads only work
unsandboxed. Result: preload fails to load, `window.tandem` is never exposed, and the renderer's
first `window.tandem.onTextEvent(...)` (app/renderer/src/main.tsx:162) throws.

Fix (preferred): configure electron-vite to emit the preload as CJS (`build.rollupOptions.output`
format `cjs`, filename `index.js`) and update the `preload:` path in `app/main/index.ts`
accordingly. Alternative (acceptable): set `sandbox: false` in webPreferences, keeping
`contextIsolation: true` and `nodeIntegration: false` — state which you chose and why in the
completion report.

Also add a defensive guard: in the renderer entry, if `window.tandem` is undefined, render a
clear message ("preload bridge failed to load — see main process logs") instead of throwing on
property access, so future bridge regressions are self-explaining.

Verify by actually launching: `npm run dev:app` must open the window with the sidebar and
composer visible and `models:list` populated. State in the report that you launched it.

## D6-2: Review scores inconsistent with verdict (low priority)
Live run 11's verdict was `approve` with a clearly positive userSummary but scores 1/1/1 —
likely a sloppy fill by the model or the prose-extraction path. Two cheap hardenings:
1. In the reviewer/extraction prompts, state that scores must be consistent with the verdict
   (approve implies the work met the bar; 1 = severe failure).
2. In `ReviewVerdictSchema` or post-validation, if `verdict === "approve"` and any score <= 2,
   treat it as a validation failure so the retry/nudge/extraction chain gets a chance to correct
   it (mirror the existing enforceVerification pattern). Unit-test both directions (approve with
   low scores rejected; revise with low scores allowed).

## Acceptance
tsc + `npm test` green; commits `D6-1:` / `D6-2:`; the reviewer will relaunch `dev:app` on the
user's machine and expects the chat UI to load, then will drive a live GUI run.
