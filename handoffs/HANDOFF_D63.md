# Handoff D63 (default maxParallelWorkers to 2)

## Context
User confirmed via a real live test (2-stream plan, real leader partitioning, real concurrent
worker dispatch, real merge, approved 5/5/5) that multi-worker (D54/D58) works correctly, then
asked to enable it by default. Today `defaultConfig.maxParallelWorkers` is `1` (set when D54
introduced the field) — sequential, no parallelism, even though the leader will only ever
partition a plan into multiple streams when it judges tasks genuinely independent
(`streamPartitioningRule`already guards this). Raising the default cap doesn't change behavior for
single-stream plans at all (the cap only matters once there are 2+ streams to dispatch), so this
is a low-risk default change.

I already manually updated the user's own live configs (`~/.tandem/config.json` and the two
active project-level configs that were shadowing it —`tmp_test_data` and
`tmp_test_data\dogfight-game`) to `"maxParallelWorkers": 2`, verified via the real
`loadConfigDetails` function. That's a runtime-data fix, not a source change. This handoff is
just the source default, for fresh installs going forward.

## D63-1: Change the default
`src/config/schema.ts`: change `defaultConfig.maxParallelWorkers` from `1` to `2`.

## Acceptance
tsc + `npm test` green. Check for any existing test that asserts
`defaultConfig.maxParallelWorkers === 1` and update it to `2` (search for it — don't leave a
test locking in the old default). Commit `D63-<n>:`, create `D63_done.txt`.
