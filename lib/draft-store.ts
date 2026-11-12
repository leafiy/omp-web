import { stripPastedTokens, type PastedText } from "./pasted-text";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export type ChatDraftPastedText = PastedText;

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
  /** Content behind the `[paste #n …]` markers in `value`. */
  pastedTexts?: ChatDraftPastedText[];
  notice?: string;
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const storageKey = (key: string) => `omp-web:draft:v1:${encodeURIComponent(key)}`;
// Larger pastes stay memory-only so one draft cannot exhaust localStorage for the others.
const MAX_PERSISTED_PASTED_CHARS = 500_000;
const clone = (draft: ChatDraft): ChatDraft => ({
  ...draft,
  images: draft.images.map(image => ({ ...image })),
  // Entries are immutable and keep their identity; only the list is copied.
  ...(draft.pastedTexts ? { pastedTexts: [...draft.pastedTexts] } : {}),
});
const readPastedTexts = (value: unknown): ChatDraftPastedText[] => Array.isArray(value)
  ? value.filter((entry): entry is ChatDraftPastedText => !!entry && Number.isSafeInteger(entry.id) && entry.id > 0 && typeof entry.text === "string" && !!entry.text)
    .map(({ id, text }) => ({ id, text }))
  : [];

/** Images remain memory-only; text survives refresh without uploading drafts to the server. */
export function createDraftStore(storage: () => DraftStorage | undefined) {
  const drafts = new Map<string, ChatDraft>();
  function getDraft(key: string): ChatDraft | null {
    const cached = drafts.get(key);
    if (cached) return clone(cached);
    try {
      const raw = storage()?.getItem(storageKey(key));
      if (!raw) return null;
      const saved = JSON.parse(raw);
      if (saved.version !== 1 || typeof saved.value !== "string" || !saved.value) return null;
      const pastedTexts = readPastedTexts(saved.pastedTexts);
      const draft: ChatDraft = { value: saved.value, images: [], ...(pastedTexts.length ? { pastedTexts } : {}) };
      drafts.set(key, draft);
      return clone(draft);
    } catch { return null; }
  }
  function clearDraft(key: string): void {
    drafts.delete(key);
    try { storage()?.removeItem(storageKey(key)); } catch { /* Private mode / blocked storage. */ }
  }
  function setDraft(key: string, draft: ChatDraft): void {
    if (!draft.value && !draft.images.length) { clearDraft(key); return; }
    drafts.set(key, clone(draft));
    try {
      const pastedTexts = draft.pastedTexts ?? [];
      if (draft.value && pastedTexts.length && pastedTexts.reduce((total, entry) => total + entry.text.length, 0) <= MAX_PERSISTED_PASTED_CHARS) {
        try {
          storage()?.setItem(storageKey(key), JSON.stringify({ version: 1, value: draft.value, pastedTexts }));
          return;
        } catch { /* Quota: fall back to the typed text alone. */ }
      }
      // A marker whose content is not persisted must not reload as literal text.
      const value = stripPastedTokens(draft.value, pastedTexts);
      if (value) storage()?.setItem(storageKey(key), JSON.stringify({ version: 1, value }));
      else storage()?.removeItem(storageKey(key));
    } catch { /* Quota or private mode: keep the in-memory draft usable. */ }
  }
  function clearDraftIfUnchanged(key: string, sent: ChatDraft): void {
    const current = getDraft(key);
    const pasted = current?.pastedTexts ?? [], sentPasted = sent.pastedTexts ?? [];
    if (current?.value === sent.value && current.images.length === sent.images.length
      && current.images.every((image, i) => image.data === sent.images[i].data && image.mimeType === sent.images[i].mimeType)
      && pasted.length === sentPasted.length
      && pasted.every((entry, i) => entry.id === sentPasted[i].id && entry.text === sentPasted[i].text)) clearDraft(key);
  }
  return { getDraft, setDraft, clearDraft, clearDraftIfUnchanged };
}

export const { getDraft, setDraft, clearDraft, clearDraftIfUnchanged } = createDraftStore(
  () => typeof window === "undefined" ? undefined : window.localStorage,
);
