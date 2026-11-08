import type { SessionData } from "../hooks/useAgentSession";

export class HistoryRequestError extends Error { constructor(readonly status: number) { super(`History HTTP ${status}`); } }
type Entry = { data?: SessionData; etag?: string; bytes: number; pending?: Promise<SessionData> };

/**
 * Per-tab, bounded RAM only. No localStorage, IndexedDB, credentials or runtime state.
 * Removing an entry detaches (never aborts) its in-flight request: callers already
 * awaiting it still get a response, but it can no longer repopulate the cache.
 * Aborting surfaced as "AbortError" chat failures when a title update raced a reload.
 */
export function createHistoryClientCache(fetcher: typeof fetch = (...args) => fetch(...args), maxBytes = 20 * 1024 * 1024, maxEntries = 8) {
  const cache = new Map<string, Entry>();
  function remove(key: string) { cache.delete(key); }
  function trim() {
    let bytes = [...cache.values()].reduce((n, entry) => n + entry.bytes, 0);
    for (const [key, entry] of cache) {
      if (cache.size <= maxEntries && bytes <= maxBytes) break;
      bytes -= entry.bytes; remove(key);
    }
  }
  return {
    peek(url: string) { const entry = cache.get(url); if (entry) { cache.delete(url); cache.set(url, entry); } return entry?.data; },
    invalidate(sessionId?: string) {
      const prefix = sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}?` : "";
      for (const key of cache.keys()) if (key.startsWith(prefix)) remove(key);
    },
    load(url: string): Promise<SessionData> {
      const previous = cache.get(url);
      if (previous?.pending) return previous.pending;
      const entry: Entry = previous ?? { bytes: 0 };
      cache.delete(url); cache.set(url, entry);
      const work = Promise.resolve().then(async () => {
        const response = await fetcher(url, { cache: "no-store", headers: entry.etag ? { "If-None-Match": entry.etag } : {} });
        if ([401, 403].includes(response.status)) { for (const key of cache.keys()) remove(key); throw new HistoryRequestError(response.status); }
        if (response.status === 404) { const prefix = url.split("?")[0] + "?"; for (const key of cache.keys()) if (key.startsWith(prefix)) remove(key); throw new HistoryRequestError(404); }
        if (response.status === 304 && entry.data) return entry.data;
        if (!response.ok) throw new HistoryRequestError(response.status);
        const text = await response.text(), data = JSON.parse(text) as SessionData;
        const expectedId = decodeURIComponent(new URL(url, "http://history.local").pathname.split("/").at(-1)!);
        if (data.sessionId !== expectedId || !Array.isArray(data.context?.messages) || data.context.messages.length !== data.context.entryIds?.length) throw new Error("Invalid history response");
        if (cache.get(url) === entry) {
          entry.data = data; entry.etag = response.headers.get("etag") ?? undefined; entry.bytes = text.length * 3; trim();
        }
        return data;
      }).finally(() => { if (entry.pending === work) entry.pending = undefined; });
      entry.pending = work; trim(); return work;
    },
  };
}
export const historyClientCache = createHistoryClientCache();
export function historyUrl(id: string, extra: Record<string, string> = {}): string {
  return `/api/sessions/${encodeURIComponent(id)}?${new URLSearchParams({ window: "1", limit: "60", deferThinking: "1", deferMedia: "1", ...extra })}`;
}
