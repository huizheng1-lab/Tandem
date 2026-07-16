# Handoff to GPT-5 — Round D33 (file attachments: PDF, images — the Claude Code way)

User request: upload PDFs, images, and other files like Claude Code supports. Claude Code's
model, which we adopt: files travel BY PATH (drag/paste stores the file, the prompt references
the path), and the agent's read tool returns real multimodal content (image blocks, PDF pages)
to models that support it.

## D33-1: Composer attachments (desktop)
- Drag-and-drop onto the window, paste-from-clipboard (images), and a paperclip button (native
  file picker) on the composer.
- Attached files are copied into `<projectDir>\attachments\` (create on demand; collision-safe
  names `name-2.ext`). Pasted images become `pasted-<timestamp>.png`.
- The composer shows attachment chips (name + size, removable before send). On send, the prompt
  gains a trailing block: `[Attached files: attachments\spec.pdf, attachments\mock.png]`, and
  the user-turn event records the attachment paths.
- Size guard: refuse files > 20 MB with a clear message.

## D33-2: Multimodal leader turns
- `RunnerMessage.content` must support AI SDK content parts (string | parts array with
  `{type:"image"}` and `{type:"file", mediaType:"application/pdf"}` entries).
- When a user turn has attachments AND the leader model supports the media type (see D33-4),
  the leader's user message includes the actual image/file parts alongside the text. Otherwise
  append a graceful note instead: `[image attached at attachments\mock.png — this model cannot
  view images; its dimensions are WxH]`.
- Thread persistence/compaction: store attachment PATHS in the session log (never base64);
  rebuild parts from disk on resume; compaction summaries mention attachments by name.

## D33-3: read_file becomes media-aware (both agents)
- Image extensions (png/jpg/jpeg/gif/webp) → return an image content part via the AI SDK v5
  tool-result content mechanism when the CALLING model supports images; else return a text
  stub (path, format, dimensions via a tiny header parse — no new heavy deps).
- `.pdf` → file part for PDF-capable models; else text stub (path, page count if cheaply
  readable, size).
- Existing text behavior unchanged; binary detection must not regress reading source files.

## D33-4: Media capability flags in the registry
- `ModelEntry.media?: { images?: boolean; pdf?: boolean }` — set: google/* {images,pdf};
  anthropic/* {images,pdf}; openai/gpt-5* {images}; minimax + openai-compatible customs default
  none, overridable via customModels config.
- `/models` and the model dropdowns show a small media badge (e.g. "img+pdf").

## Acceptance
tsc + `npm test` green (content-parts plumbing, capability gating, stub fallbacks, attachment
naming); commits `D33-<n>:`. Reviewer will live-test: attach a small PNG and ask the
Gemini-leader "what color is the square in this image?" (correct answer required, no build);
attach a 1-page PDF and ask for its title; worker path: a run whose plan requires reading the
attached image with a MiniMax worker must degrade to the text stub without erroring.
