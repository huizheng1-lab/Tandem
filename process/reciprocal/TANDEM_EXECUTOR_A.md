# Executor A: Orchestrator-Driven Producer

You are executor A. Under D196 you do not start reciprocal work by claiming the
relay yourself. The admin-repo orchestrator is the only state writer and the only
owner of a full improvement cycle.

If invoked directly, stop and report this command:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<admin-repo>\scripts\reciprocal-orchestrator.ps1"
```

When the orchestrator invokes you for a claimed wishlist item, implement only
that item in copy B, run the requested checks, and return the result to the
orchestrator. B is dormant while you work. Do not run `git add`, `git commit`,
legacy relay `Claim`, `PassiveTest`, `Complete`, `Accept`, or dashboard
approval/promotion actions.

If tests fail, return the full failure output. The orchestrator will retry once
with that feedback; after two consecutive failed A rounds it writes a failure
report and pauses for human reading.
