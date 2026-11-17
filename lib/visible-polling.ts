/** One in-flight request per subscriber. Hidden/offline tabs do no polling;
 * focus, visibility and connectivity recovery coalesce into an immediate check.
 * Consumers must ignore aborted results before applying state.
 */
export function startVisiblePolling(
  task: (signal: AbortSignal, recovered: boolean) => Promise<void>,
  intervalMs: number,
  immediate = true,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: AbortController | undefined;
  let recoverAgain = false;
  const available = () => document.visibilityState === "visible" && navigator.onLine !== false;
  const clearTimer = () => { clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    clearTimer();
    if (!stopped && available()) timer = setTimeout(() => void poll(false), intervalMs);
  };
  const poll = async (recovered: boolean) => {
    if (stopped || !available()) return;
    if (pending) { recoverAgain ||= recovered; return; }
    recoverAgain = false;
    clearTimer();
    const controller = new AbortController();
    pending = controller;
    try { await task(controller.signal, recovered); }
    catch { /* Keep the last snapshot; retry on the next visible tick. */ }
    finally {
      pending = undefined;
      if (!stopped && recoverAgain && available()) {
        recoverAgain = false;
        void poll(true);
      } else schedule();
    }
  };
  const recover = () => {
    if (available()) void poll(true);
    else { clearTimer(); pending?.abort(); }
  };
  document.addEventListener("visibilitychange", recover);
  window.addEventListener("focus", recover);
  window.addEventListener("online", recover);
  window.addEventListener("offline", recover);
  if (immediate) void poll(false); else schedule();
  return () => {
    stopped = true;
    clearTimer();
    pending?.abort();
    document.removeEventListener("visibilitychange", recover);
    window.removeEventListener("focus", recover);
    window.removeEventListener("online", recover);
    window.removeEventListener("offline", recover);
  };
}
