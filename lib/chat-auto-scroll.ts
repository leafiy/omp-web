const STORAGE_KEY = "omp-web:chat-auto-scroll";
const CHANGE_EVENT = "omp-web:chat-auto-scroll-change";
let fallback = true;

export function readChatAutoScroll(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? fallback : stored !== "false";
  } catch { return fallback; }
}

export function writeChatAutoScroll(enabled: boolean): void {
  fallback = enabled;
  try { localStorage.setItem(STORAGE_KEY, String(enabled)); } catch { /* In-memory fallback. */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeChatAutoScroll(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) { fallback = true; listener(); }
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, listener);
  };
}
