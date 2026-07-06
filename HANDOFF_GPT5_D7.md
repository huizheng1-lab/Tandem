# Handoff to GPT-5 — Round D7 (desktop UX findings from first user test)

Context: D6 APPROVED; the desktop app now launches and renders correctly. The user's first real
GUI session surfaced these findings (screenshot-verified by the reviewer).

## D7-1: Pipeline error leaves the UI stuck in a running state
Repro: start a run that fails immediately (e.g. missing API key for the selected model). The
error appears as a SYSTEM message, but the phase chip stays "PLANNING" and the composer button
stays "Stop" — the user had to press Stop manually ("Abort requested"). Fix in
`app/renderer/src/main.tsx` (and `app/main/tandem-service.ts` if the run promise isn't
rejecting/notifying): any pipeline termination — done, error, or abort — must reset phase to
IDLE (or DONE), restore the Send button, and re-enable the composer. Add a `evt:done`-equivalent
error event or reuse the existing done event with an `error` flag so the renderer has one
authoritative "run over" signal. Unit-test the service: a run whose agents throw must still emit
the terminal event.

## D7-2: Missing-key error should be actionable in the GUI
The error text tells the user to edit `.env` — CLI-era advice. In the GUI, when `pipeline:run`
(or `session:start`) fails with the missing-env-key error, additionally show a banner or modal:
which key is missing, which model wants it, and a hint that keys live in `<projectDir>\.env` or
`~\.tandem\.env` (global). No secret input field — do NOT build key entry into the UI in this
round; just clear guidance. (Reviewer note: global fallback files now exist on this machine, so
fresh folders inherit the user's config; this task is about the error experience, not loading.)

## D7-3: Session start should surface the effective models
Cosmetic: on session start, the SYSTEM line shows session id + folder. Append the resolved
leader/worker ids so a config surprise (like D7's default-fallback) is visible before the first
run, e.g. "Session … started in … — leader google/gemini-2.5-pro, worker minimax/minimax-m2.7".

## Acceptance
tsc + `npm test` green; commits `D7-<n>:`; reviewer relaunches dev:app and re-tests the failure
path (unknown key) and a successful run.
