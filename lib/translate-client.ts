import type { TranslateStatus } from "./translate-config";
import type { TranslateDirection } from "./translate-text";

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
