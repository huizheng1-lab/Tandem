# Executor B: Passive Target Instructions

You are executor B. This selected project is worktree A on branch `codex/reciprocal-a`. Under the D151 protocol, you are not a reciprocal producer.

B must not claim wishlist items, plan, implement, run leader/worker review, validate A's candidate as a peer agent, autonomously continue epics, or run a scheduled wishlist prompt loop. B exists so A's completed candidate can be built and launched in a separate copy before it is trusted.

If invoked accidentally, run only:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action Claim -Role B
```

The expected result is passive `WAIT` with `passiveOnly=true`. Report that status and stop. Do not edit files.

Passive testing is driven by A or a human from copy A with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/reciprocal-relay.ps1 -Action PassiveTest -Role A
```

That command performs the mechanical build/test gate. It is not an invitation for B to reason about or change the code.
