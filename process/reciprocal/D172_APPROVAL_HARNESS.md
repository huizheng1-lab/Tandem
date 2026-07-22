# D172 Approval Harness Evidence

Purpose: record the external dashboard harness changes for D172. The dashboard
operational files live outside this git repository at
`C:\Users\huizh\Apps\Tandem Reciprocal\dashboard`.

Changed external files:
- `server.mjs`
  - SHA256: `DBD4C873D488E8544105B8E21EA434351212BCD7E95E944B6C28131DCCE81A82`
  - Added `TANDEM_DASHBOARD_TEST_HARNESS=1` command doubles for executor
    stop/start and runtime promotion.
  - Command doubles log all PowerShell invocations when
    `TANDEM_DASHBOARD_COMMAND_LOG` is set.
  - The real `scripts/reciprocal-relay.ps1` still runs for relay state changes.
- `approval-flow.e2e.mjs`
  - SHA256: `E416A8557C163F4F9E684CA67B198D68A45C69742ED274B11EFB967404DD26F8`
  - Creates a temporary git repository, real `codex/reciprocal-a` and
    `codex/reciprocal-b` worktrees, isolated relay state, isolated runtime
    BUILD_INFO files, and isolated review/audit files.
  - Starts the dashboard server against that fixture and calls the dashboard
    approval/recovery HTTP endpoints with the served control token.

Approval-flow fixture proof:
- Initial state: `phase=a-upgrade-pending`, `activeRole=null`,
  `stableCommit=<fixture SHA>`.
- Route: `POST /api/update/approve`.
- Expected audit step order:
  1. `a-upgrade-boundary`
  2. `review-recorded`
  3. `executors-stopped`
  4. `runtime-promoted`
  5. `executors-restarted`
  6. `a-upgrade-completed`
- Exact relay action log assertion:
  - no `Pause`
  - no `Resume`
  - one `CompleteAUpgrade`
  - command contains `-Workspace <fixture>\relay\worktrees\copy-a`
  - command contains `-Role A`
  - command contains `-Force`
  - command contains a non-empty `-Summary`
- The test asserts the real relay result detail contains `a_upgrade_completed`
  and the persisted fixture state becomes `phase=idle`, `activeRole=null`,
  `nextRole=A`.
- The mock promotion path is invoked exactly once.

Recovery fixture proof:
- Initial state: `phase=paused`, `pausedFromPhase=a-upgrade-pending`,
  `activeRole=null`, `stableCommit=<approved fixture SHA>`.
- Fixture review index records `decision=approve`.
- Fixture Executor A and B BUILD_INFO values match the approved fixture SHA.
- Route: `POST /api/update/approve/recover-a-upgrade`.
- Exact relay/action log assertion:
  - action list is exactly `[CompleteAUpgrade]`
  - no runtime promotion helper
  - no executor stop helper
  - no executor start helper
  - no generic `Resume`
  - no wishlist/direction command
- The persisted fixture state becomes `phase=idle`.
- Audit contains `update.approvePromoteRecovery` with
  `mode=already-promoted-relay-gate-recovered`.

Recovery negative cases:
- wrong `pausedFromPhase`
- active role
- stable SHA mismatch
- rejected review decision
- Executor A BUILD_INFO mismatch
- Executor B BUILD_INFO mismatch

Each negative case asserts HTTP 400, unchanged fixture state, no relay action,
and no promotion helper invocation.
