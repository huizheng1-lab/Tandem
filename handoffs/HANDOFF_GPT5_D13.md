# Handoff to GPT-5 — Round D13 (CRITICAL: Tandem must not modify itself)

Incident (reviewer-verified, 2026-07-05 ~3:15 AM): the user ran their standing goal ("build an
airplane dogfight game") in a session whose projectDir was the TANDEM REPO ITSELF. The worker,
in yolo permission mode, found `app/renderer/`, deleted the entire 822-line desktop UI from
`main.tsx`, replaced it with a three.js `<Game />`, and installed `three` into Tandem's own
package.json. The next `dist:app` rebuild then shipped the hijacked renderer — the packaged app
literally became the cube game. The reviewer reverted the working tree (the game file was saved
to the user's folders) and is rebuilding a clean package. Nothing was committed, so git history
is intact.

Two root causes to fix:

## D13-1: Default projectDir must never be Tandem's own code
The app currently defaults its working folder to `process.cwd()` (the repo, in dev; the install
dir, packaged). Change the default to a safe workspace: `~\TandemProjects` (create on first run)
— and show a prominent "choose your project folder" state in the UI until the user explicitly
picks one for a session. Never silently operate in cwd.

## D13-2: Protected-path guard in the tool layer
Add a self-protection check in `src/tools/fs.ts` + `src/tools/shell.ts` (alongside the
destructive-command denylist, same spirit):
- Compute Tandem's own installation/source root at startup (in dev: the repo containing
  `src/orchestrator/machine.ts`; packaged: `app.getAppPath()` / the resources dir, plus the
  running executable's directory).
- If the session projectDir is, contains, or is inside any protected root: refuse write/edit
  and bash for that session with a clear error ("Tandem will not modify its own installation.
  Pick a different project folder."). Read-only tools may still work.
- Also protect `~\.tandem` (config/keys/sessions) from write/edit/bash regardless of projectDir.
- No UI override for this in any permission mode, including yolo. (A power user can still work
  on Tandem's source with a DIFFERENT tool — Tandem itself refuses, like a surgeon not
  operating on themselves.)
Unit tests: projectDir == source root refused; projectDir inside it refused; sibling folder
allowed; `~\.tandem` writes refused from an allowed projectDir.

## D13-3: Session-start visibility
Extend the session-start SYSTEM line to include the projectDir prominently (it already shows
models/permissions). If the folder is empty vs. contains an existing project, say so:
"working in C:\...\tandem_test (existing project, 14 files)". The incident went unnoticed
partly because the user did not realize which folder the session was operating on.

## Acceptance
tsc + `npm test` green; commits `D13-<n>:`. Reviewer will attempt to run a session against the
Tandem repo and against `~\.tandem` and expects refusal in both; a normal folder must work
unchanged; fresh install/dev launch must default to `~\TandemProjects`.
