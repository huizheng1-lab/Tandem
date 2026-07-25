# Handoff D132 (the last sandbox gap: git index.lock still denied even with .git granted - find the real mechanism, then route around it)

D131 granted the common git dir (`C:\Users\huizh\Apps\HZ code\.git`) via --add-dir, yet
the sandboxed executor STILL could not create the index lock for its linked worktree
(`.git\worktrees\copy-a\index.lock`). Everything else in the unattended cycle now works
(schedule fires, claim, Start, implement, verify, Pause) - the ONLY remaining manual step
is the final `git add/commit`. One precise round to close it.

## D132-1: identify the actual denial mechanism first - do not guess another root

Primary hypothesis to test FIRST: Codex CLI's workspace-write sandbox treats `.git`
directories as read-only BY DESIGN (agent-can't-corrupt-history policy), independent of
--add-dir grants. Check codex-cli 0.144.2's actual behavior/documentation/config surface
for this (e.g. a `sandbox_workspace_write` option governing git or dot-dir writes, or a
hardcoded exclusion). Probe it directly: `codex exec --sandbox workspace-write --add-dir
<...>\.git` with a trivial command that creates a file inside `.git\worktrees\copy-a\`
(and one inside `.git\tandem-relay\` for contrast - note D129's relay-state writes DID
succeed after --add-dir, so compare what differs: path depth? the `worktrees` subdir? a
`.git`-name-based rule that somehow exempted `tandem-relay`? lock-file semantics
(O_CREAT|O_EXCL)? Get the real answer with probes, and state it in the marker.

## D132-2: fix per what you find - preferred shape if .git is sandbox-excluded

If .git writes are indeed policy-excluded from the codex sandbox (or the mechanism is
otherwise unfixable via config): stop asking the sandboxed model to run `git commit` at
all. Move the commit into the RELAY layer, which the model already invokes and which the
protocol already treats as the sanctioned mutation route: add a `CommitCandidate`-style
action to `scripts/reciprocal-relay.ps1` (or fold into `Complete`) that - when invoked
by the model with an explicit file list + commit message - verifies the file list against
protocol rules (no .tandem, no TANDEM.md, no secrets/build output; refuse otherwise),
stages exactly those files in the target worktree, creates the single `relay:` commit,
and reports the SHA. KEY QUESTION to answer before building: does a PowerShell script
spawned by the sandboxed codex process inherit the sandbox restrictions (D129's evidence
says relay-state writes through the script DID work after --add-dir, so script children
CAN write where codex can) - if script children are equally blocked from .git, the
commit must instead be performed by the UNSANDBOXED Tandem app layer (e.g. an automation
verb or a service-level post-build step triggered on Complete), which is a bigger change
- pick the simplest route that a REAL sandboxed probe proves works. Update PROTOCOL.md
and executor templates to match whatever lands.

## D132-3: prove the full unattended cycle at last

Queue a small SCRATCH wishlist item (normal, non-epic, trivially small - e.g. add one
line to a docs file - autonomy irrelevant since non-epic items don't plan-gate), resume
the relay, and let the schedules run the ENTIRE cycle with zero injection and zero admin
recovery: claim -> implement -> commit (via the new route) -> Complete -> peer VALIDATE
-> Accept. The negative evidence standard from D131 applies (no /prompt calls in the
audit window). Then remove the scratch item (D125 Remove) and leave the relay paused.
This proof is the round's acceptance bar - if any step still needs a human/conductor,
report exactly which and why rather than working around it silently.

## Acceptance

Marker states: the probed mechanism (with raw probe output), the chosen fix and why,
PROTOCOL/template diffs quoted, and the full unattended-cycle evidence with timestamps +
the no-injection negative evidence. tsc + `npm test` green in the admin repo. Runtime
promotion only if app code changed (schedule/automation layers), through the normal
gate. Relay left paused; scratch item removed with a note. Commit `D132-<n>:`. Create
`handoffs/D132_done.txt`.
