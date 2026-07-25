# Handoff D142 (investigate what's silently killing reciprocal background processes)

Real live incident: both reciprocal executors (Tandem.exe, hidden, isolated) vanished
entirely - zero matching processes - while the relay was mid-turn (`phase: working`,
`resumeCount: 0`, no repeated-failure pattern this time; the process was alive as of
its last `updatedAt` and simply gone ~30 minutes later with no trace). I restarted both
and kickstarted the interrupted turn; no data was lost (relay state/checkpoints are
durable by design), but this is the SECOND class of process this session has died
without any exit/crash trace - D141 found the exact same shape for the dashboard
watchdog+server pair (both die together, no exit log, external kill mechanism assumed
but not confirmed).

## Why this deserves its own investigation now

D141 fixed the dashboard's symptom (scheduled-task supervision survives the kill) but
explicitly did NOT confirm the root mechanism - it said "likely... an external
process-tree cleanup" without identifying what. Now the SAME shape has hit a different
process family (the executor Tandem.exe instances, not started by the dashboard code
at all - started via `start-reciprocal-tandem.ps1`'s own `Start-Process` calls). Two
independently-launched process families dying together in the same silent way strongly
suggests a shared external cause, not two coincidental unrelated bugs. Fixing this at
the root (or at least identifying it) matters more than adding scheduled-task
supervision to every single background process one at a time.

## Investigation

1. Check Windows Event Viewer (Application and System logs, and specifically the
   Kernel-Process / User-PnP or Reliability logs) around the approximate death window
   for any indication of what terminated these PIDs - a Job Object cleanup, a Windows
   Update-triggered restart, antivirus/Defender action, power/sleep-related process
   suspension, or a parent-process-exit cascade.
2. Check HOW these processes are actually launched: `start-reciprocal-tandem.ps1` uses
   `Start-Process` from within a PowerShell session that is itself invoked by this
   Claude Code environment's Bash/PowerShell tool. If that outer PowerShell process (or
   a Job Object it or its parent belongs to) gets torn down when a tool-call session
   ends or is recycled, and child processes were created WITHOUT explicit detachment
   from that job object, Windows can and will kill the entire job (including
   grandchildren) when the job handle closes - this is a well-known Windows Job Object
   behavior, not a bug in Tandem's own code. Confirm or rule this out specifically:
   check whether `Start-Process` in this environment creates processes that inherit a
   job object association from the invoking shell, and whether `-WindowStyle Hidden`
   changes that. If confirmed, the fix is to explicitly break the child out of any
   inherited job object at creation time (e.g. `CREATE_BREAKAWAY_FROM_JOB` or
   equivalent .NET/PowerShell mechanism), not a scheduled-task workaround per process.
3. If (2) is the cause, this affects EVERY hidden background process this project
   launches this way (dashboard server before D141's fix, both executors, any future
   automation) - a single root fix (breakaway at launch) is far better than repeating
   D141's per-process scheduled-task pattern for each new background process the
   project adds.

## Fix direction (adjust based on what's found)

If it's a job-object inheritance issue: make `Start-Process` calls in
`start-reciprocal-tandem.ps1` (and any other launcher) explicit about breaking away
from the parent's job object, and verify with a real reproduction (launch, close/recycle
whatever the actual parent context is, confirm the child survives). If it's something
else entirely (Windows Update, antivirus, power management), report that honestly with
evidence and propose the narrowest reasonable mitigation (e.g. if it's sleep/power-
related, that may just need to be documented as a known constraint rather than "fixed").

## Acceptance

Root cause identified with real evidence (Event Viewer entries, a controlled
reproduction, or equivalent - not a guess). If a code fix applies, demonstrate it: start
an executor, trigger whatever the actual killing condition turned out to be, confirm
the process now survives. If the cause is external/environmental and not fixable in
code, say so plainly and document it (e.g. in the reciprocal README's known-limitations
section) rather than leaving it as a silent mystery. tsc + `npm test` green if any code
changed. Commit `D142-<n>:` for any script changes. Create `handoffs/D142_done.txt`.
