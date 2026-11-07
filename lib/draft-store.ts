export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
  notice?: string;
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const storageKey = (key: string) => `omp-web:draft:v1:${encodeURIComponent(key)}`;
const clone = (draft: ChatDraft): ChatDraft => ({ ...draft, images: draft.images.map(image => ({ ...image })) });

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
      const draft = { value: saved.value, images: [] };
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
      if (draft.value) storage()?.setItem(storageKey(key), JSON.stringify({ version: 1, value: draft.value }));
      else storage()?.removeItem(storageKey(key));
    } catch { /* Quota or private mode: keep the in-memory draft usable. */ }
  }
  function clearDraftIfUnchanged(key: string, sent: ChatDraft): void {
    const current = getDraft(key);
    if (current?.value === sent.value && current.images.length === sent.images.length
      && current.images.every((image, i) => image.data === sent.images[i].data && image.mimeType === sent.images[i].mimeType)) clearDraft(key);
  }
  return { getDraft, setDraft, clearDraft, clearDraftIfUnchanged };
}

export const { getDraft, setDraft, clearDraft, clearDraftIfUnchanged } = createDraftStore(
  () => typeof window === "undefined" ? undefined : window.localStorage,
);
