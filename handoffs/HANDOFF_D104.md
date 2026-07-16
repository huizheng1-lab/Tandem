# Handoff D104 (rebuild the packaged app)

No code change. The packaged app (`npm run dist:app`) is stale — last build predates D101,
D102, and D103, so the user's running app doesn't have the path-quoting fix, the takeover
verification warning, the raised step-budget default, or the step-exhaustion auto-retry.
No Tandem app instance is currently running (nothing should lock `win-unpacked`).

Run `npm run dist:app`. Confirm it completes without error. Commit nothing (dist/ output is
already gitignored per prior rounds - if it isn't, don't add it). Create
`handoffs/D104_done.txt` noting the build completed and the commit SHA it was built from.
