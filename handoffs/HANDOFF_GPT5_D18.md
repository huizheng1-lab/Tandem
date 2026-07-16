# Handoff to GPT-5 — Round D18 (test hygiene: never touch the real ~/.tandem)

Reviewer-confirmed twice: running the test suite (or your local manual testing) overwrites the
user's real `~\.tandem\desktop-state.json` `lastProjectDir` with throwaway temp dirs
(`%TEMP%\tandem-desktop-...`). The user's "Continue in <last folder>" button then points at
garbage. The reviewer has manually restored the state twice.

## D18-1: Isolate all test/dev state from the real home directory
- Audit every code path that writes under `~\.tandem` (desktop-state, config, sessions index,
  env): each must accept an injectable base/home dir, and every test must pass a temp dir —
  no test may read or write the real `homedir()`. The desktop-service tests that exercise
  `startSession` are the known offenders (they persist lastProjectDir via the real state file).
- Add a guard in the test setup (vitest setup file): fail the suite if anything touches
  `join(homedir(), ".tandem")` during tests — e.g., monkeypatch/spy the state-file module's
  default path in tests, or set an env override (`TANDEM_HOME`) that ALL state modules honor,
  point it at a temp dir in test setup, and assert the real path was untouched.
- `TANDEM_HOME` env override is the preferred mechanism (also useful for users); document it in
  the README.

## Acceptance
tsc + `npm test` green; commit `D18-1:`. Reviewer will: snapshot `~\.tandem\desktop-state.json`,
run the full suite, and diff — byte-identical required.
