# Handoff D107 (rebuild the packaged app)

No code change. The packaged app is still on the D104 build (commit 154b7f0) and predates
D105 and D106 - the user's running app does not yet have the Codex CLI self-healing
path-cache fix (the fix for the real `spawn ...codex.exe ENOENT` failure hit on the "three
kingdoms" project) or the corrected Claude Code CLI test coverage. No Tandem app instance
should be running; if one is, that's the user's own session and this round should wait
rather than force-close it.

Run `npm run dist:app`. Confirm it completes without error. Create
`handoffs/D107_done.txt` noting the build completed and the commit SHA it was built from
(should include 85ac71e and 2f4c4df).
