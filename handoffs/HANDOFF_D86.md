# Handoff D86 (URGENT: desktop UI becomes unresponsive / unable to type on large sessions)

User report tonight, desktop app: "the ui is not very responsive when i tried to manage the
sessions. it does not even allow me to type in the chat box." Confirmed via targeted questions
this was NOT a stuck-run state (the Send/Stop button correctly showed "Send", not "Stop") and
predates any session-management action (was already frozen before they tried Archive/Delete) — so
this is not a D85 regression. Live-observed on the user's actual running instance: the Electron
renderer process (PID captured mid-incident) was resident at **1.27GB of memory**, drastically
abnormal for an idle chat UI. User's real "tandem_hyperframe_video" project has session logs with
100k+ raw JSONL lines (visible from the D79-D85 incident arc). I closed the frozen instance for
the user (their explicit go-ahead; no data lost, everything is durably appended to disk as it
happens) as an immediate workaround — a fresh process relieves the symptom, but the underlying bug
needs a real fix so it doesn't recur once that session grows large again.

**User follow-up (2026-07-11, after the app was closed and reopened):** "tandem uses a lot of
memory. we need to manage the memory use as claude code does." This confirms the diagnosis below
and sets the explicit design goal for the fix: Tandem's desktop UI should manage memory the way
Claude Code's own interface does — bounded, recent-window rendering with full history still
available on disk, not "load and keep every event from the entire session in memory/DOM forever."
This reframes D86-3 (below) from optional polish to part of the actual goal, not just D86-1's
DOM-node count. Treat "how much of the session lives in memory at once" as the real target, not
just "how many DOM nodes are mounted" — a fix that keeps all 100k events as JS objects in React
state but only renders a windowed slice would still leave real memory pressure on the table.

## Root cause (confirmed via code read, live memory observation; NOT yet confirmed via full
## interactive click-through — see "What I could not verify" below)

`app/renderer/src/main.tsx`:
- `replaySession()` (~line 470-508) converts EVERY event in a resumed session's `.jsonl` file into
  a `TranscriptEntry` pushed onto an array (`replayed`), which becomes the `entries` state via
  `setEntries(replayed)`. Text/thinking deltas are coalesced onto the last matching entry, but
  every `machine` event (`transition`, `artifact`, `error`, and any tool-call/streaming event kind
  not explicitly coalesced) becomes its own permanent array entry. For a session with 100k+ raw
  events, this can still produce many thousands of distinct rendered entries after coalescing.
- The render path (~line 1048, 1294) is `const visibleEntries = showActivity ? entries :
  entries.filter((entry) => entry.kind !== "tool"); ... {visibleEntries.map((entry) => ...)}`.
  This is a plain `.filter()` + `.map()` — **no virtualization or windowing of any kind** (grepped
  the whole file: no react-window, no react-virtuoso, no manual windowing). Every entry becomes a
  real DOM node, unconditionally.
- The chat composer's `<textarea>` (~line 1375-1388) lives in the SAME top-level `App()` function
  component as this giant entries list. Its `onChange` calls `setPrompt(...)`, which triggers a
  re-render of the entire `App` component — including reconciling the full, un-memoized
  `visibleEntries.map(...)` tree — on every single keystroke. With a transcript in the thousands-
  of-entries range, this reconciliation work per keystroke is almost certainly what makes typing
  feel like it "does not even allow me to type" (keystrokes registering with severe lag or
  appearing dropped as the render thread falls behind), and generally explains "not very
  responsive" for other interactions (Archive/Delete clicks) too, since those also trigger renders
  of the same component tree.
- The 1.27GB live memory figure is consistent with this: thousands of DOM nodes plus their
  associated React fiber tree and string content for a 100k-line session is a very plausible
  contributor to that scale of memory growth, though I have not isolated memory attribution
  precisely (e.g., via a heap snapshot) — flagging that as a nice-to-have, not required, in the
  acceptance section below.

## What I could not verify live (be honest, don't claim more than confirmed)

Tandem enforces a single-instance lock (by design, from D12), so I could not launch a second,
isolated test window with a debug port while the user's real instance was running to do a full
CDP click-through reproduction (dispatch real keystrokes into the textarea on a large resumed
session and measure actual input lag/dropped-keys). I DID build a real 20,000-event session via
the actual `SessionStore` API in a throwaway project as a reproduction fixture, but was blocked
from loading it in an isolated app window by the same single-instance lock. The root cause above
is code-confirmed (no virtualization exists, full-component re-render on every keystroke is
structurally certain from reading the code) plus supported by the live 1.27GB memory observation,
but the exact keystroke-lag magnitude was not independently measured by me. **Please independently
verify the fix eliminates the actual lag** (e.g., resume/rebuild a session with a comparably large
event count, type in the composer, and confirm it feels responsive), not just "renders without
crashing."

## What to do

D86-1 (primary fix): virtualize the transcript list so only entries near the visible viewport are
mounted as real DOM nodes. Given no virtualization library is currently a dependency, either add a
small one (e.g. `react-window` — check it's compatible with the installed React version before
adding) or implement simple windowing manually (e.g. only render the last N entries by default
with a "load older messages" affordance, since chat UIs conventionally don't need the full 100k-
event history mounted at once — Claude Code's own UI and most chat apps only render recent
history eagerly). Pick whichever is the smaller, more proportionate change given the codebase;
don't over-engineer a general-purpose virtualized-list abstraction if a simple recency cap solves
the real problem.

D86-2 (should naturally fall out of D86-1, but verify explicitly): confirm the composer textarea's
`onChange`/typing path no longer requires reconciling the full transcript tree — i.e., typing
should be smooth regardless of session size after the fix.

D86-3 (now part of the actual goal, not optional polish — see the user's follow-up above):
`replaySession()` still walks and converts literally every raw event from a 100k-line file into a
`TranscriptEntry` up front, keeping ALL of them in React state (`entries`) even if D86-1 only
windows which ones get RENDERED as DOM nodes. That still means the full session's text content
sits in JS memory at all times. Match how Claude Code's own UI handles long history: keep only a
bounded recent window of entries actually loaded into memory/state by default (e.g., last N
events, or last N minutes/messages — pick whatever's proportionate to this codebase), with older
history paged in from disk on demand (e.g., a "load older messages" action that reads more of the
`.jsonl` file and prepends entries) rather than converted and held in memory the instant a session
is resumed. This is the same principle for `SessionStore.append()`-driven live growth during an
active run: entries should not be allowed to grow unbounded in renderer memory over a long-running
session either — consider capping in-memory entries during a live run the same way, trimming the
oldest once a bound is hit, since the full transcript remains safely on disk regardless.

## Acceptance

tsc + `npm test` green. Live verification (this one genuinely requires a real UI test, not just
code review, given the nature of this bug): build a real session with several thousand+ transcript
entries (reuse/adapt the `SessionStore`-based synthetic-session approach above, or use a real large
session file if one is available), resume it in the packaged app, and confirm: (a) typing in the
composer feels immediately responsive with no perceptible lag, (b) memory usage after resuming is
not wildly disproportionate to a normal-sized session — paste an actual before/after resident-memory
comparison (Task Manager or equivalent) for the resumed-large-session case, matching the 1.27GB
figure I observed so there's a real before/after number, not just "it built fine", (c) session
management actions (Archive/Delete/Rename) remain responsive. Since the single-instance lock blocked me from doing this
myself in an isolated window, this live check is squarely on you this round — please actually do
it and paste real before/after observations (rough memory figures, a description of typing feel)
in the completion report rather than asserting success from code review alone. Commit `D86-<n>:`,
create `D86_done.txt` in `handoffs/` (not the repo root — files were reorganized there; see
`handoffs/HANDOFF_D85.md`'s sibling if useful context, and put your own completion marker in
`handoffs/D86_done.txt`).
