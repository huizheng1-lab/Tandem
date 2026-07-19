import React, { useEffect, useState } from "react";
import type {
  SessionSearchBatchEvent,
  SessionSearchCancelRequest,
  SessionSearchRequest
} from "../../shared/ipc.js";

export type SessionSearchHit = SessionSearchBatchEvent["hits"][number];

export interface SessionSearchState {
  searchId: string | null;
  query: string;
  hits: SessionSearchHit[];
  scannedCount: number;
  skippedCount: number;
  scanning: boolean;
  done: boolean;
  error?: string;
}

export const initialSessionSearchState: SessionSearchState = {
  searchId: null,
  query: "",
  hits: [],
  scannedCount: 0,
  skippedCount: 0,
  scanning: false,
  done: false
};

export type SessionSearchEvent =
  | { type: "start"; searchId: string; query: string }
  | { type: "batch"; batch: SessionSearchBatchEvent }
  | { type: "error"; message: string }
  | { type: "reset" };

export function reduceSessionSearch(state: SessionSearchState, event: SessionSearchEvent): SessionSearchState {
  switch (event.type) {
    case "start":
      return {
        searchId: event.searchId,
        query: event.query,
        hits: [],
        scannedCount: 0,
        skippedCount: 0,
        scanning: true,
        done: false,
        error: undefined
      };
    case "batch": {
      if (event.batch.searchId !== state.searchId) return state;
      return {
        ...state,
        hits: event.batch.hits,
        scannedCount: event.batch.scannedCount,
        skippedCount: event.batch.skippedCount,
        done: event.batch.done || state.done,
        scanning: !event.batch.done,
        error: undefined
      };
    }
    case "error":
      return { ...state, scanning: false, done: true, error: event.message };
    case "reset":
      return { ...initialSessionSearchState };
    default:
      return state;
  }
}

export interface SearchSnippetSegment {
  text: string;
  highlighted: boolean;
}

export function searchSnippetSegments(snippet: { text: string; start: number; end: number }): SearchSnippetSegment[] {
  if (!snippet.text) return [];
  const safeStart = Math.max(0, Math.min(snippet.text.length, Math.floor(snippet.start)));
  const safeEnd = Math.max(safeStart, Math.min(snippet.text.length, Math.floor(snippet.end)));
  if (safeStart === 0 && safeEnd === snippet.text.length) {
    return [{ text: snippet.text, highlighted: true }];
  }
  const segments: SearchSnippetSegment[] = [];
  if (safeStart > 0) segments.push({ text: snippet.text.slice(0, safeStart), highlighted: false });
  segments.push({ text: snippet.text.slice(safeStart, safeEnd), highlighted: true });
  if (safeEnd < snippet.text.length) segments.push({ text: snippet.text.slice(safeEnd), highlighted: false });
  return segments;
}

export function searchSourceLabel(role: SessionSearchHit["sourceRole"]): string {
  switch (role) {
    case "title":
      return "Title";
    case "user":
      return "Prompt";
    case "leader":
      return "Leader";
    case "worker":
      return "Worker";
    case "summary":
      return "Summary";
    case "compaction":
      return "Compaction";
  }
}

export interface SessionSearchClock {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const realClock: SessionSearchClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export const DEFAULT_SEARCH_DEBOUNCE_MS = 120;

export interface SessionSearchApi {
  startSessionSearch(request: SessionSearchRequest): Promise<void>;
  cancelSessionSearch(request: SessionSearchCancelRequest): Promise<void>;
}

export type SessionSearchListener = (state: SessionSearchState) => void;

export interface SessionSearchControllerOptions {
  api: SessionSearchApi;
  debounceMs?: number;
  clock?: SessionSearchClock;
  generateSearchId?: () => string;
}

export interface SessionSearchController {
  getState(): SessionSearchState;
  setQuery(query: string): void;
  clear(): void;
  onBatch(batch: SessionSearchBatchEvent): void;
  onError(message: string): void;
  subscribe(listener: SessionSearchListener): () => void;
  destroy(): void;
}

let searchIdCounter = 0;
function defaultGenerateSearchId(): string {
  searchIdCounter += 1;
  return `search-${Date.now().toString(36)}-${searchIdCounter}`;
}

export function createSessionSearchController(options: SessionSearchControllerOptions): SessionSearchController {
  const api = options.api;
  const debounceMs = options.debounceMs ?? DEFAULT_SEARCH_DEBOUNCE_MS;
  const clock = options.clock ?? realClock;
  const generateSearchId = options.generateSearchId ?? defaultGenerateSearchId;

  let state: SessionSearchState = { ...initialSessionSearchState };
  const listeners = new Set<SessionSearchListener>();
  let debounceHandle: unknown = undefined;
  let destroyed = false;

  function setState(next: SessionSearchState): void {
    state = next;
    for (const listener of listeners) listener(state);
  }

  function apply(event: SessionSearchEvent): void {
    setState(reduceSessionSearch(state, event));
  }

  function cancelDebounce(): void {
    if (debounceHandle !== undefined) {
      clock.clearTimeout(debounceHandle);
      debounceHandle = undefined;
    }
  }

  function cancelActive(): void {
    cancelDebounce();
    const activeId = state.searchId;
    if (activeId) {
      void api.cancelSessionSearch({ searchId: activeId }).catch(() => undefined);
    }
  }

  return {
    getState: () => state,
    setQuery(query) {
      if (destroyed) return;
      cancelActive();
      const trimmed = query.trim();
      if (!trimmed) {
        setState({ ...initialSessionSearchState });
        return;
      }
      // Retire the canceled search ID before the debounce expires so a final
      // in-flight batch cannot repopulate results for the previous query.
      setState({ ...initialSessionSearchState, query: trimmed });
      debounceHandle = clock.setTimeout(() => {
        debounceHandle = undefined;
        if (destroyed) return;
        const searchId = generateSearchId();
        apply({ type: "start", searchId, query: trimmed });
        api.startSessionSearch({ searchId, query: trimmed }).catch((error: unknown) => {
          if (destroyed) return;
          if (state.searchId !== searchId) return;
          apply({ type: "error", message: error instanceof Error ? error.message : String(error) });
        });
      }, debounceMs);
    },
    clear() {
      if (destroyed) return;
      cancelActive();
      setState({ ...initialSessionSearchState });
    },
    onBatch(batch) {
      if (destroyed) return;
      apply({ type: "batch", batch });
    },
    onError(message) {
      if (destroyed) return;
      apply({ type: "error", message });
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
    destroy() {
      destroyed = true;
      cancelActive();
      listeners.clear();
    }
  };
}

export interface SearchSessionResultsProps {
  state: SessionSearchState;
  onSelect: (id: string) => void;
  onClear: () => void;
  relativeTime: (value: string) => string;
}

export function SearchSessionResults({ state, onSelect, onClear, relativeTime }: SearchSessionResultsProps): React.ReactElement {
  const showScanning = state.scanning && !state.done;
  const showNoMatch = state.done && !state.error && state.hits.length === 0;
  const showError = Boolean(state.error);
  const showSkipped = state.skippedCount > 0;
  const sessionCountLabel = `${state.scannedCount} session${state.scannedCount === 1 ? "" : "s"}`;
  const matchCountLabel = `${state.hits.length} match${state.hits.length === 1 ? "" : "es"}`;
  const statusText = showError
    ? `Search failed: ${state.error}`
    : showScanning
      ? `Scanning ${sessionCountLabel}...`
      : state.done
        ? `${matchCountLabel} across ${sessionCountLabel}`
        : `${matchCountLabel} so far`;

  return (
    <div
      className="sessionSearchResults"
      role="region"
      aria-label="Session search results"
      aria-live="polite"
    >
      <div className="sessionSearchHeader">
        <span className="sessionSearchStatus" data-testid="session-search-status">
          {statusText}
        </span>
        <button type="button" className="linkButton" onClick={onClear} disabled={!state.query && !state.scanning}>
          Clear search
        </button>
      </div>
      {showSkipped ? (
        <div className="sessionSearchSkipped">
          Skipped {state.skippedCount} session file{state.skippedCount === 1 ? "" : "s"} (unreadable or malformed).
        </div>
      ) : null}
      <div className="sessionSearchList">
        {state.hits.map((hit) => {
          const projectLabel = hit.projectDir ?? "Unresolved project";
          const timeLabel = hit.lastActiveAt ? relativeTime(hit.lastActiveAt) : "";
          const matchLabel = `${hit.matchCount} match${hit.matchCount === 1 ? "" : "es"}`;
          return (
            <button
              key={hit.id}
              type="button"
              className="sessionSearchRow"
              data-hit-id={hit.id}
              onClick={() => onSelect(hit.id)}
              title={hit.lastActiveAt}
            >
              <span className="sessionSearchTitle">{hit.title || hit.id.slice(0, 8)}</span>
              <span className="sessionSearchMeta">
                <span className="sessionSearchProject" title={hit.projectDir ?? ""}>
                  {projectLabel}
                </span>
                <span className="sessionSearchRole">{searchSourceLabel(hit.sourceRole)}</span>
                <span className="sessionSearchTime">{timeLabel}</span>
                <span className="sessionSearchMatchCount">{matchLabel}</span>
              </span>
              <span className="sessionSearchSnippet">
                {searchSnippetSegments(hit.snippet).map((segment, index) =>
                  segment.highlighted ? (
                    <mark key={index} className="sessionSearchHighlight">
                      {segment.text}
                    </mark>
                  ) : (
                    <React.Fragment key={index}>{segment.text}</React.Fragment>
                  )
                )}
              </span>
            </button>
          );
        })}
        {showNoMatch ? <div className="sessionSearchEmpty">No sessions match this query.</div> : null}
      </div>
    </div>
  );
}

export interface UseSessionSearchControllerOptions {
  api: SessionSearchApi;
  debounceMs?: number;
}

export function useSessionSearchController({ api, debounceMs }: UseSessionSearchControllerOptions): {
  state: SessionSearchState;
  controller: SessionSearchController;
} {
  const controllerRef = React.useRef<SessionSearchController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createSessionSearchController({ api, debounceMs });
  }
  const controller = controllerRef.current;
  const [state, setState] = useState<SessionSearchState>(controller.getState());
  useEffect(() => {
    return controller.subscribe(setState);
  }, [controller]);
  useEffect(() => () => controller.destroy(), [controller]);
  return { state, controller };
}
