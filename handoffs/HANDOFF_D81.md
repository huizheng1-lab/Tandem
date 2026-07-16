# Handoff D81 (batched: stall-threshold relaxation + session-resume folder-pick bug)

Two items, batched per the user's own "accumulate before writing" preference. Independent fixes,
different areas of the codebase — can be done in either order, same round.

## D81-1 (small): relax the "model call may be stalled" threshold

`app/renderer/src/main.tsx:1037` hardcodes the stall warning at 60s:
```ts
const stripText = noActivitySeconds > 60 ? `no activity for ${noActivitySeconds}s - the model call may be stalled (Stop to abort)` : activityText;
```
(also referenced at `~line 1317` for the `stalled` CSS class). This fires too early — real,
legitimate `claude-code/cli` leader calls routinely run 150s+ during genuine multi-step
exploration (live-confirmed this session: a real planning call ran 151s+ doing normal work, and
a separate real call from earlier project history ran 36 internal turns over a minute, $1.17).
User asked to relax this window so it doesn't falsely suggest a stall during normal operation.

Raise the threshold to something more realistic for CLI-backed engines — 180s (3 minutes) is a
reasonable starting point given the observed real-call durations, but use your own judgment; if
you want to differentiate by engine (CLI-backed engines legitimately run longer than direct
API calls per-turn) that's a reasonable enhancement, but don't over-engineer this — a single
relaxed constant is an acceptable, sufficient fix unless a per-engine threshold is trivial to add
cleanly. Don't remove the warning entirely — it's still useful for genuinely stuck calls, just
currently too trigger-happy.

## D81-2 (large): resuming an existing session re-prompts for a folder it already has

Root-caused fully via code read before writing this — confirmed, not guessed.

**Immediate bug:** `replaySession()` in `app/renderer/src/main.tsx:458-467` ends with:
```ts
setSession((current) => (current ? { ...current, sessionId: id, defaultProject: false } : current));
```
This is a functional state updater that NO-OPS when `session` is currently `null` — e.g. the
desktop app just started and no session has been picked/started yet in this window. In that
case `defaultProject: false` never gets applied, `session` stays `null`, and
`needsProjectPick = !session || Boolean(session.defaultProject)` (line 234) stays `true` —
triggering the "Choose your project folder" prompt even though the user just explicitly clicked
an existing session from the sidebar that already has a real, known project directory.

**Deeper gap underneath that:** `SessionResumeResponse` (`app/shared/ipc.ts:162-166`) doesn't
carry `projectDir`/`config`/`projectSummary` back to the renderer at all — only `id`, `events`,
`checkpoint`. The backend's `resumeSession()` (`app/main/tandem-service.ts:301`) opens the
session store using whatever `this.projectDir` ALREADY happens to be set to on the TandemService
instance — it never validates that this matches the session actually being resumed, and never
returns which project the session belongs to. So even fixing the immediate `setSession` no-op
above wouldn't be enough on its own if `this.projectDir` doesn't already happen to match — the
renderer has nothing correct to populate `session.projectDir` with from the resume response.
(The session's real project dir IS recoverable — the very first `session:start` event embeds it
in text, e.g. "Session ... started; working in <projectDir> ..." per how
`app/renderer/src/main.tsx:82` formats it — but nothing currently extracts and uses that
structurally.)

### What to do
1. Extend `SessionResumeResponse` (`app/shared/ipc.ts`) to include `projectDir`, `config`, and
   `projectSummary` — mirror whatever `SessionStartResponse` already returns for consistency,
   don't invent a different shape.
2. Fix `resumeSession()` on the backend (`app/main/tandem-service.ts:301`) to determine and
   return the session's ACTUAL origin project directory, not just assume `this.projectDir` is
   already correct. Check how sessions are indexed/stored (`SessionStore.open`,
   `listSessions`) — there's likely already a reliable way to know which project a given session
   id belongs to without needing `this.projectDir` pre-set correctly; use that rather than
   re-deriving it by parsing the replayed event text.
3. Fix `replaySession()` in the renderer to unconditionally construct a full `session` object
   from the resume response (using the now-real `projectDir`/`config`), not a patch-if-exists
   update that silently no-ops when `session` is `null`.
4. Regression-check the CURRENTLY-WORKING case isn't broken: resuming a session when one is
   ALREADY active (`session` non-null) should still work exactly as it does today.

## Acceptance
tsc + `npm test` green for both. D81-2 needs a real regression test: simulate the null-session
resume path specifically (the exact scenario that's broken today — fresh app state, no session
active, resume an existing session directly) and confirm `projectDir` ends up correctly
populated and `needsProjectPick` is `false` afterward. Live verification required for D81-2 (UI-
facing, same bar as this session's other desktop rounds): rebuild the packaged app, fully close
it, relaunch fresh, click an existing session directly from the sidebar with NO project picked
first, confirm it resumes straight into that session's real project without prompting for a
folder. D81-1 doesn't need live verification beyond the constant change + a quick sanity check
that the stalled-CSS class/message still fires at the new threshold. Commit `D81-<n>:`, create
`D81_done.txt`.
