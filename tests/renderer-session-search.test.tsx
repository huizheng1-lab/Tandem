import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  createSessionSearchController,
  initialSessionSearchState,
  reduceSessionSearch,
  SearchSessionResults,
  searchSnippetSegments,
  type SessionSearchClock,
  type SessionSearchHit
} from "../app/renderer/src/search-session-results.js";

const hit: SessionSearchHit = {
  id: "session-1",
  title: "Release investigation",
  lastActiveAt: "2026-07-19T12:00:00.000Z",
  projectDir: "C:\\projects\\a-very-long-project-name\\tandem",
  matchCount: 2,
  sourceRole: "leader",
  snippet: { text: "Found the release regression in the renderer.", start: 10, end: 17 }
};

describe("session search reducer", () => {
  it("replaces progressive snapshots and ignores stale batches", () => {
    const started = reduceSessionSearch(initialSessionSearchState, { type: "start", searchId: "current", query: "release" });
    const stale = reduceSessionSearch(started, {
      type: "batch",
      batch: { searchId: "stale", hits: [hit], scannedCount: 99, skippedCount: 0, done: true }
    });
    expect(stale).toBe(started);

    const progressive = reduceSessionSearch(started, {
      type: "batch",
      batch: { searchId: "current", hits: [hit], scannedCount: 4, skippedCount: 1, done: false }
    });
    expect(progressive).toMatchObject({ hits: [hit], scannedCount: 4, skippedCount: 1, scanning: true, done: false });

    const replacement = reduceSessionSearch(progressive, {
      type: "batch",
      batch: { searchId: "current", hits: [], scannedCount: 8, skippedCount: 1, done: true }
    });
    expect(replacement).toMatchObject({ hits: [], scannedCount: 8, scanning: false, done: true });
  });
});

describe("session search controller", () => {
  it("debounces starts, cancels the active search, clears, and unsubscribes", async () => {
    let callback: (() => void) | undefined;
    let scheduledDelay: number | undefined;
    const clock: SessionSearchClock = {
      setTimeout(next, ms) {
        callback = next;
        scheduledDelay = ms;
        return 1;
      },
      clearTimeout() {
        callback = undefined;
      }
    };
    const startSessionSearch = vi.fn(async () => undefined);
    const cancelSessionSearch = vi.fn(async () => undefined);
    const controller = createSessionSearchController({
      api: { startSessionSearch, cancelSessionSearch },
      clock,
      generateSearchId: () => "search-1"
    });
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);

    controller.setQuery(" release ");
    expect(startSessionSearch).not.toHaveBeenCalled();
    expect(scheduledDelay).toBe(120);
    callback?.();
    await Promise.resolve();
    expect(startSessionSearch).toHaveBeenCalledWith({ searchId: "search-1", query: "release" });
    expect(controller.getState()).toMatchObject({ searchId: "search-1", query: "release", scanning: true });

    controller.setQuery("next query");
    expect(cancelSessionSearch).toHaveBeenCalledWith({ searchId: "search-1" });
    const retiredState = controller.getState();
    expect(retiredState).toMatchObject({ searchId: null, query: "next query", hits: [] });
    controller.onBatch({ searchId: "search-1", hits: [hit], scannedCount: 10, skippedCount: 0, done: true });
    expect(controller.getState()).toBe(retiredState);

    controller.clear();
    expect(cancelSessionSearch).toHaveBeenCalledWith({ searchId: "search-1" });
    expect(controller.getState()).toEqual(initialSessionSearchState);
    unsubscribe();
    const callsAfterUnsubscribe = listener.mock.calls.length;
    controller.setQuery("another");
    expect(listener).toHaveBeenCalledTimes(callsAfterUnsubscribe);
    controller.destroy();
  });
});

describe("SearchSessionResults", () => {
  it("renders progress, project metadata, exact highlighting, and selection wiring", () => {
    const markup = renderToStaticMarkup(
      <SearchSessionResults
        state={{
          searchId: "search-1",
          query: "release",
          hits: [hit],
          scannedCount: 5,
          skippedCount: 1,
          scanning: true,
          done: false
        }}
        onSelect={() => undefined}
        onClear={() => undefined}
        relativeTime={() => "2h ago"}
      />
    );
    expect(markup).toContain("Scanning 5 sessions");
    expect(markup).toContain("Skipped 1 session file");
    expect(markup).toContain("Release investigation");
    expect(markup).toContain("C:\\projects\\a-very-long-project-name\\tandem");
    expect(markup).toContain("Leader");
    expect(markup).toContain("2h ago");
    expect(markup).toContain("data-hit-id=\"session-1\"");
    expect(markup).toContain("<mark class=\"sessionSearchHighlight\">release</mark>");
  });

  it("shows terminal no-match and error states only when appropriate", () => {
    const base = { ...initialSessionSearchState, searchId: "search-1", query: "missing", done: true };
    const emptyMarkup = renderToStaticMarkup(
      <SearchSessionResults state={base} onSelect={() => undefined} onClear={() => undefined} relativeTime={() => ""} />
    );
    expect(emptyMarkup).toContain("No sessions match this query.");
    expect(emptyMarkup).toContain("0 matches across 0 sessions");

    const errorMarkup = renderToStaticMarkup(
      <SearchSessionResults state={{ ...base, error: "disk unavailable" }} onSelect={() => undefined} onClear={() => undefined} relativeTime={() => ""} />
    );
    expect(errorMarkup).toContain("Search failed: disk unavailable");
    expect(errorMarkup).not.toContain("No sessions match");
  });

  it("clamps snippet highlight offsets", () => {
    expect(searchSnippetSegments({ text: "abc", start: -10, end: 2 })).toEqual([
      { text: "ab", highlighted: true },
      { text: "c", highlighted: false }
    ]);
  });
});
