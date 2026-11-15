import { collapsePastedBlocks, expandPastedTokens, livePastedTexts, stripPastedTokens, type PastedText } from "./pasted-text";
import { isAttachedFile, type AttachedFile } from "./file-attachments";
import { extractMessageFiles } from "./user-message-content";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export type ChatDraftPastedText = PastedText;

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
  /** Uploaded file metadata only; file bodies stay on disk, never in localStorage. */
  files?: AttachedFile[];
  /** Content behind the `[paste #n …]` markers in `value`. */
  pastedTexts?: ChatDraftPastedText[];
  notice?: string;
}

/** Queue recall shares the same restoration path whether its composer is mounted or not. */
export function prependDraftMessage(draft: ChatDraft | null, text: string, notice?: string): ChatDraft {
  const current: ChatDraft = draft ?? { value: "", images: [] };
  const restored = extractMessageFiles(text);
  const pasted = current.pastedTexts ?? [];
  const adopted = restored.text === expandPastedTokens(current.value, pasted)
    ? null : collapsePastedBlocks(restored.text, livePastedTexts(current.value, pasted));
  const files = [...(current.files ?? [])];
  for (const file of restored.files) if (!files.some(existing => existing.path === file.path)) files.push(file);
  return {
    ...current,
    value: adopted ? [adopted.value, current.value].filter(value => value.trim()).join("\n\n") : current.value,
    pastedTexts: adopted?.pastedTexts ?? pasted,
    files,
    ...(notice ? { notice } : {}),
  };
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const storageKey = (key: string) => `omp-web:draft:v1:${encodeURIComponent(key)}`;
// Larger pastes stay memory-only so one draft cannot exhaust localStorage for the others.
const MAX_PERSISTED_PASTED_CHARS = 500_000;
const clone = (draft: ChatDraft): ChatDraft => ({
  ...draft,
  images: draft.images.map(image => ({ ...image })),
  ...(draft.files ? { files: draft.files.map(file => ({ ...file })) } : {}),
  // Entries are immutable and keep their identity; only the list is copied.
  ...(draft.pastedTexts ? { pastedTexts: [...draft.pastedTexts] } : {}),
});
const readPastedTexts = (value: unknown): ChatDraftPastedText[] => Array.isArray(value)
  ? value.filter((entry): entry is ChatDraftPastedText => !!entry && Number.isSafeInteger(entry.id) && entry.id > 0 && typeof entry.text === "string" && !!entry.text)
    .map(({ id, text }) => ({ id, text }))
  : [];

/** Images remain memory-only; text and uploaded file metadata survive refresh locally. */
export function createDraftStore(storage: () => DraftStorage | undefined) {
  const drafts = new Map<string, ChatDraft>();
  function getDraft(key: string): ChatDraft | null {
    const cached = drafts.get(key);
    if (cached) return clone(cached);
    try {
      const raw = storage()?.getItem(storageKey(key));
      if (!raw) return null;
      const saved = JSON.parse(raw);
      if (saved.version !== 1 || typeof saved.value !== "string") return null;
      const files: AttachedFile[] = Array.isArray(saved.files) ? saved.files.filter(isAttachedFile) : [];
      if (!saved.value && !files.length) return null;
      const pastedTexts = readPastedTexts(saved.pastedTexts);
      const draft: ChatDraft = { value: saved.value, images: [], ...(files.length ? { files } : {}), ...(pastedTexts.length ? { pastedTexts } : {}) };
      drafts.set(key, draft);
      return clone(draft);
    } catch { return null; }
  }
  function clearDraft(key: string): void {
    drafts.delete(key);
    try { storage()?.removeItem(storageKey(key)); } catch { /* Private mode / blocked storage. */ }
  }
  function setDraft(key: string, draft: ChatDraft): void {
    if (!draft.value && !draft.images.length && !draft.files?.length) { clearDraft(key); return; }
    drafts.set(key, clone(draft));
    try {
      const files = draft.files?.length ? draft.files : undefined;
      const pastedTexts = draft.pastedTexts ?? [];
      if (draft.value && pastedTexts.length && pastedTexts.reduce((total, entry) => total + entry.text.length, 0) <= MAX_PERSISTED_PASTED_CHARS) {
        try {
          storage()?.setItem(storageKey(key), JSON.stringify({ version: 1, value: draft.value, pastedTexts, files }));
          return;
        } catch { /* Quota: fall back to the typed text alone. */ }
      }
      // A marker whose content is not persisted must not reload as literal text.
      const value = stripPastedTokens(draft.value, pastedTexts);
      if (value || files) storage()?.setItem(storageKey(key), JSON.stringify({ version: 1, value, files }));
      else storage()?.removeItem(storageKey(key));
    } catch { /* Quota or private mode: keep the in-memory draft usable. */ }
  }
  function clearDraftIfUnchanged(key: string, sent: ChatDraft): void {
    const current = getDraft(key);
    const pasted = current?.pastedTexts ?? [], sentPasted = sent.pastedTexts ?? [];
    const files = current?.files ?? [], sentFiles = sent.files ?? [];
    if (current?.value === sent.value && current.images.length === sent.images.length
      && files.length === sentFiles.length
      && files.every((file, i) => file.path === sentFiles[i].path && file.name === sentFiles[i].name && file.size === sentFiles[i].size)
      && current.images.every((image, i) => image.data === sent.images[i].data && image.mimeType === sent.images[i].mimeType)
      && pasted.length === sentPasted.length
      && pasted.every((entry, i) => entry.id === sentPasted[i].id && entry.text === sentPasted[i].text)) clearDraft(key);
  }
  return { getDraft, setDraft, clearDraft, clearDraftIfUnchanged };
}

export const { getDraft, setDraft, clearDraft, clearDraftIfUnchanged } = createDraftStore(
  () => typeof window === "undefined" ? undefined : window.localStorage,
);
