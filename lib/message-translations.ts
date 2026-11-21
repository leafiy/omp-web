import { isTranslateDirection, type TranslateDirection } from "./translate-text";

export type MessageTranslationState =
  | { direction: TranslateDirection; status: "loading" }
  | { direction: TranslateDirection; status: "done"; text: string }
  | { direction: TranslateDirection; status: "error"; error: string };

type TranslationStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const MESSAGE_TRANSLATIONS_STORAGE_KEY = "omp-web:message-translations:v1";
const MAX_SAVED_TRANSLATIONS = 300;
const MAX_SAVED_CHARS = 1_000_000;

/**
 * Names a message by the text that was translated (length plus a 53-bit
 * hash). Unlike an entry ID it is the same while a reply streams in, after
 * history reloads and inside a folded turn; changed text gets another key.
 */
export function translationSourceKey(source: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < source.length; i++) {
    const ch = source.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `${source.length.toString(36)}.${hash.toString(36)}`;
}

interface Entry {
  scope: string;
  key: string;
  state: MessageTranslationState;
  /** Only finished results of a conversation reach storage; loading and errors stay with the page. */
  persist: boolean;
}

/**
 * Translations shown under messages, per scope (a web session ID, or one
 * message view outside a saved conversation). Persisted results survive
 * switching conversations, folding and reloads in this browser; they are
 * display-only and never reach a transcript. Insertion order is recency;
 * storage keeps the newest within its bounds. Reads come from memory, so
 * another tab's writes arrive through `refresh` (the `storage` event).
 */
export function createMessageTranslationStore(storage: () => TranslationStorage | undefined) {
  let entries: Map<string, Entry> | null = null;
  const listeners = new Set<() => void>();
  const entryId = (scope: string, key: string) => `${scope}\0${key}`;

  function readStorage(): Entry[] {
    try {
      const raw = storage()?.getItem(MESSAGE_TRANSLATIONS_STORAGE_KEY);
      const list: unknown = raw ? (JSON.parse(raw) as { entries?: unknown } | null)?.entries : [];
      if (!Array.isArray(list)) return [];
      return list.flatMap((item): Entry[] => Array.isArray(item)
        && typeof item[0] === "string" && !!item[0]
        && typeof item[1] === "string" && !!item[1]
        && isTranslateDirection(item[2]) && typeof item[3] === "string"
        ? [{ scope: item[0], key: item[1], state: { direction: item[2], status: "done", text: item[3] }, persist: true }]
        : []);
    } catch { return []; /* Blocked or corrupt storage: start empty. */ }
  }

  function load(): Map<string, Entry> {
    entries ??= new Map(readStorage().map((entry) => [entryId(entry.scope, entry.key), entry]));
    return entries;
  }

  function notify(): void {
    for (const listener of listeners) listener();
  }

  function save(map: Map<string, Entry>): void {
    const saved = [...map.values()].filter((entry) => entry.persist && entry.state.status === "done");
    // Newest first until a bound is reached; whatever does not fit stays for this page only.
    let chars = 0;
    let kept: Entry[] = [];
    for (let i = saved.length - 1; i >= 0; i--) {
      const entry = saved[i];
      const size = entry.state.status === "done" ? entry.state.text.length : 0;
      if (kept.length >= MAX_SAVED_TRANSLATIONS || chars + size > MAX_SAVED_CHARS) { entry.persist = false; continue; }
      chars += size;
      kept.push(entry);
    }
    kept.reverse();
    for (;;) {
      try {
        const store = storage();
        if (!store) return;
        if (!kept.length) store.removeItem(MESSAGE_TRANSLATIONS_STORAGE_KEY);
        else store.setItem(MESSAGE_TRANSLATIONS_STORAGE_KEY, JSON.stringify({
          version: 1,
          entries: kept.map((entry) => [entry.scope, entry.key, entry.state.direction, entry.state.status === "done" ? entry.state.text : ""]),
        }));
        return;
      } catch {
        // Quota or blocked storage: give up the oldest half and try again.
        if (!kept.length) return;
        const dropped = Math.ceil(kept.length / 2);
        for (const entry of kept.slice(0, dropped)) entry.persist = false;
        kept = kept.slice(dropped);
      }
    }
  }

  function readMessageTranslation(scope: string, key: string): MessageTranslationState | null {
    return load().get(entryId(scope, key))?.state ?? null;
  }

  /** `null` forgets the translation (closed); the views of that message update. */
  function writeMessageTranslation(scope: string, key: string, state: MessageTranslationState | null, persist: boolean): void {
    const map = load();
    const id = entryId(scope, key);
    const previous = map.get(id);
    map.delete(id);
    if (state) map.set(id, { scope, key, state, persist });
    if ((previous?.persist && previous.state.status === "done") || (persist && state?.status === "done")) save(map);
    notify();
  }

  /** Another tab changed storage: take its saved results, keep this page's own work. */
  function refresh(): void {
    if (!entries) return;
    const current = entries;
    const next = new Map<string, Entry>();
    for (const entry of readStorage()) {
      const id = entryId(entry.scope, entry.key);
      const mine = current.get(id);
      // Same result: keep its identity so the message does not re-render.
      const same = mine?.state.status === "done" && entry.state.status === "done"
        && mine.state.direction === entry.state.direction && mine.state.text === entry.state.text;
      next.set(id, same && mine ? { ...mine, persist: true } : entry);
    }
    for (const [id, entry] of current) {
      if (!entry.persist || entry.state.status !== "done") next.set(id, entry);
    }
    entries = next;
    notify();
  }

  function subscribeMessageTranslations(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  return { readMessageTranslation, writeMessageTranslation, subscribeMessageTranslations, refresh };
}

const browserStore = createMessageTranslationStore(
  () => typeof window === "undefined" ? undefined : window.localStorage,
);

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === null || event.key === MESSAGE_TRANSLATIONS_STORAGE_KEY) browserStore.refresh();
  });
}

export const { readMessageTranslation, writeMessageTranslation, subscribeMessageTranslations } = browserStore;
