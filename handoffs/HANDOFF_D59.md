# Handoff D59 (add a copy button to chat messages, so earlier prompts are easy to re-copy)

## Context
User wants to easily copy the text of earlier messages in the desktop app's transcript
(specifically their own prior prompts, but this is a generically useful feature — no reason to
scope it to only `user`-role bubbles). Today there's no way to copy a message's text except
manual text-selection in the transcript, which is fiddly across the role badge / bubble padding /
multi-line wrapped text.

This is desktop-app only. The CLI TUI is a terminal app — copying already works there via the
terminal emulator's own text selection (no in-app affordance needed or expected; don't touch
`src/tui/App.tsx` for this).

## D59-1: Add a copy button to each message bubble
In `app/renderer/src/main.tsx`, the transcript render loop (~line 1168-1176) renders each message
entry as:
```jsx
<article key={entry.id} className={`bubble ${entry.role}...`}>
  <div className="roleBadge">{roleLabel(entry.role)}</div>
  <div className="messageText">{entry.text}</div>
</article>
```
Add a small copy button to this bubble (all roles — user, system, leader, worker — not just
user). Suggested placement: absolutely positioned in the bubble's top-right corner (or inline
next to the role badge — your call on whichever fits the existing bubble padding/layout better),
visible on hover (`:hover .copyButton { opacity: 1 }` pattern, matching how transient UI chrome
is typically shown in this codebase) rather than always-visible clutter.

Click handler: copy `entry.text` (the exact raw message text, not a formatted/truncated version)
to the clipboard. Use the standard Web Clipboard API (`navigator.clipboard.writeText(text)`) —
Electron renderer processes have this available without needing a new IPC channel; don't add one
unless you find `navigator.clipboard` is actually blocked in this app's specific
webPreferences/CSP (check before assuming you need an IPC round-trip through the main process).

Give brief visual feedback on a successful copy (e.g. swap the button's icon/label to a checkmark
or "Copied" for ~1.5s via a local `useState`, then revert) so the user has confirmation it
worked. Handle the clipboard-write promise rejecting (rare, but don't leave an unhandled
rejection) — on failure, a brief inline error state is fine; don't throw or crash the transcript.

## D59-2: Don't disturb existing behavior
- Artifact cards (`entry.kind === "artifact"`) and tool lines (`entry.kind === "tool"`) are NOT in
  scope for this round — only `entry.kind === "message"` bubbles. (If you think artifact cards
  would also benefit from a copy button, mention it in the completion report rather than silently
  expanding scope.)
- The copy button must not interfere with existing text selection (a user should still be able to
  click-drag to select a range spanning multiple bubbles if they want to, same as today).
- No change to `appendMessage`/entry data shape needed — the button just reads `entry.text`,
  already present.

## Acceptance
tsc + `npm test` green (a UI-only change; if there's no existing test coverage for transcript
rendering, a new test isn't required, but don't skip typecheck). Rebuild the packaged app
(`npm run dist:app`) and live-verify via CDP against the real running app: click the copy button
on at least one `user` bubble and one `leader`/`worker` bubble, and confirm — using
`navigator.clipboard.readText()` or by pasting into the composer textarea, whichever is more
reliable to check via CDP — that the clipboard actually contains the exact original message text.
Confirm the button doesn't appear on artifact cards or tool lines. Commit `D59-<n>:`, create
`D59_done.txt`.
