# Handoff D115 (rebuild the packaged app)

No code change. The packaged app (`release/`) is still from Jul 14 09:13, built at D107 -
it predates D108 through D113 entirely (the leader-answers-without-BuildPlan fix, all of
the global cross-project sessions work, the Fable 5 CLI model option, and the Codex/Claude
CLI path-cache self-healing). No Tandem app instance is currently running - confirmed no
`Tandem.exe` process before this handoff was written.

Run `npm run dist:app`. Confirm it completes without error. Create
`handoffs/D115_done.txt` noting the build completed and the commit SHA it was built from
(should be `57d93a8` or later).
