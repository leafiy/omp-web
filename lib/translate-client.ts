import type { TranslateStatus } from "./translate-config";
import { isTranslateDirection, type TranslateDirection } from "./translate-text";

export type { TranslateStatus };

const UNCONFIGURED: TranslateStatus = { configured: false, endpoint: "", model: "", hasApiKey: false, url: null };

let status: TranslateStatus | null = null;
let pending: Promise<TranslateStatus | null> | null = null;
const listeners = new Set<() => void>();

function parseStatus(value: unknown): TranslateStatus | null {
  const body = value as Partial<TranslateStatus> | null;
  if (!body || typeof body.configured !== "boolean") return null;
  return {
    configured: body.configured,
    endpoint: typeof body.endpoint === "string" ? body.endpoint : "",
    model: typeof body.model === "string" ? body.model : "",
    hasApiKey: body.hasApiKey === true,
    url: typeof body.url === "string" ? body.url : null,
  };
}

function setStatus(next: TranslateStatus): void {
  status = next;
  for (const listener of listeners) listener();
}

export function translateStatusSnapshot(): TranslateStatus | null {
  return status;
}

/** Subscribing loads the server status once; translate buttons stay hidden until it says configured. */
export function subscribeTranslateStatus(listener: () => void): () => void {
  listeners.add(listener);
  if (!status && !pending) void loadTranslateStatus();
  return () => { listeners.delete(listener); };
}

export function loadTranslateStatus(): Promise<TranslateStatus | null> {
  pending ??= fetch("/api/translate/config", { cache: "no-store" })
    .then(async (response) => (response.ok ? parseStatus(await response.json()) : null))
    .catch(() => null)
    .then((next) => {
      pending = null;
      if (next) setStatus(next);
      return next;
    });
  return pending;
}

async function responseError(response: Response): Promise<{ message: string; code?: string }> {
  const body = await response.json().catch(() => null) as { error?: unknown; code?: unknown } | null;
  return {
    message: typeof body?.error === "string" ? body.error : `HTTP ${response.status}`,
    code: typeof body?.code === "string" ? body.code : undefined,
  };
}

export async function saveTranslateSettings(settings: { endpoint: string; model: string; apiKey?: string }): Promise<TranslateStatus> {
  const response = await fetch("/api/translate/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!response.ok) throw new Error((await responseError(response)).message);
  const next = parseStatus(await response.json());
  if (!next) throw new Error("Invalid response from the server.");
  setStatus(next);
  return next;
}

/** Translate several texts in one request; the result keeps their order. */
export async function requestTranslation(texts: string[], direction: TranslateDirection, signal?: AbortSignal): Promise<string[]> {
  const response = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ direction, texts }),
    signal,
  });
  if (!response.ok) {
    const error = await responseError(response);
    // Settings removed from another tab or device: hide the buttons here too.
    if (error.code === "not_configured") setStatus(UNCONFIGURED);
    throw new Error(error.message);
  }
  const body = await response.json().catch(() => null) as { texts?: unknown } | null;
  const translated = body?.texts;
  if (!Array.isArray(translated) || translated.length !== texts.length || !translated.every((text) => typeof text === "string")) {
    throw new Error("Invalid response from the server.");
  }
  return translated as string[];
}

type PreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const SEND_TRANSLATION_KEY = "omp-web:translate-before-send:v2";
// The old browser-wide setting has no per-conversation meaning; it is dropped.
const LEGACY_SEND_TRANSLATION_KEY = "omp-web:translate-before-send";
const MAX_SEND_TRANSLATION_CONVERSATIONS = 200;

/**
 * The composer's translate-before-send direction per conversation, keyed like
 * drafts (a web session ID, or `new:<engine>:<cwd>` for an unsent new chat).
 * A conversation without an entry is off, so turning it on never reaches
 * another one. Storage is re-read on every call so tabs do not clobber each other.
 */
export function createSendTranslationStore(storage: () => PreferenceStorage | undefined) {
  let memory = new Map<string, TranslateDirection>();
  let legacyDropped = false;

  function load(): Map<string, TranslateDirection> {
    try {
      const store = storage();
      if (!store) return memory;
      if (!legacyDropped) {
        legacyDropped = true;
        store.removeItem(LEGACY_SEND_TRANSLATION_KEY);
      }
      const raw = store.getItem(SEND_TRANSLATION_KEY);
      const entries: unknown = raw ? (JSON.parse(raw) as { entries?: unknown } | null)?.entries : [];
      memory = new Map(Array.isArray(entries)
        ? entries.filter((entry): entry is [string, TranslateDirection] => Array.isArray(entry) && typeof entry[0] === "string" && !!entry[0] && isTranslateDirection(entry[1]))
        : []);
    } catch { /* Blocked or corrupt storage: keep this page's choices. */ }
    return memory;
  }

  function save(directions: Map<string, TranslateDirection>): void {
    // Oldest choices go first; insertion order is recency.
    while (directions.size > MAX_SEND_TRANSLATION_CONVERSATIONS) {
      const oldest = directions.keys().next().value;
      if (oldest === undefined) break;
      directions.delete(oldest);
    }
    memory = directions;
    try {
      const store = storage();
      if (!directions.size) store?.removeItem(SEND_TRANSLATION_KEY);
      else store?.setItem(SEND_TRANSLATION_KEY, JSON.stringify({ version: 2, entries: [...directions] }));
    } catch { /* The toggle still works for this page when storage is unavailable. */ }
  }

  function readSendTranslation(key: string | undefined): TranslateDirection | null {
    return key ? load().get(key) ?? null : null;
  }

  function writeSendTranslation(key: string | undefined, direction: TranslateDirection | null): void {
    if (!key) return;
    const directions = load();
    directions.delete(key);
    if (direction) directions.set(key, direction);
    save(directions);
  }

  /** The same conversation under a new key (a new chat that became a session, or moved directory). */
  function moveSendTranslation(from: string, to: string): void {
    if (from === to) return;
    const directions = load();
    const direction = directions.get(from) ?? null;
    directions.delete(from);
    directions.delete(to);
    if (direction) directions.set(to, direction);
    save(directions);
  }

  return { readSendTranslation, writeSendTranslation, moveSendTranslation };
}

export const { readSendTranslation, writeSendTranslation, moveSendTranslation } = createSendTranslationStore(
  () => typeof window === "undefined" ? undefined : window.localStorage,
);

const MAX_CACHED_TRANSLATIONS = 200;
const translationCache = new Map<string, string>();

/** Remembered message translations, so folded/remounted history keeps them without a new request. */
export function cachedTranslation(direction: TranslateDirection, text: string): string | undefined {
  return translationCache.get(`${direction}\0${text}`);
}

export function rememberTranslation(direction: TranslateDirection, text: string, translated: string): void {
  const key = `${direction}\0${text}`;
  translationCache.delete(key);
  translationCache.set(key, translated);
  if (translationCache.size > MAX_CACHED_TRANSLATIONS) {
    const oldest = translationCache.keys().next().value;
    if (oldest !== undefined) translationCache.delete(oldest);
  }
}
