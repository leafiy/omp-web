/** Browser tab titles are plain text, so a colored emoji supplies the green dot. */
export function maintainBrowserTitle(title: string, running: boolean): () => void {
  let showDot = true;
  let expectedTitle = title;
  const sync = () => {
    expectedTitle = running && showDot ? `🟢 ${title}` : title;
    if (document.title !== expectedTitle) document.title = expectedTitle;
  };
  sync();
  // Preserve the shell's existing title ownership when Next or native extension
  // UI updates the title. Observe our own changes too, without a mutation loop.
  const observer = new MutationObserver(sync);
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  const timer = running ? setInterval(() => { showDot = !showDot; sync(); }, 1000) : undefined;
  return () => {
    clearInterval(timer);
    observer.disconnect();
    if (document.title === expectedTitle) document.title = title;
  };
}

/**
 * Push-only global activity for the tab indicator. Unlike visible-tab history
 * polling, this stays attached in the background so completion clears the dot.
 * This existing endpoint observes the registry and never starts a native agent.
 */
export function subscribeBrowserActivity(onRunning: (running: boolean) => void): () => void {
  let stopped = false;
  let source: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    source?.close();
    const current = new EventSource("/api/agent/running/events");
    source = current;
    current.onmessage = (event) => {
      if (stopped || source !== current) return;
      try {
        const snapshot = JSON.parse(event.data) as { type?: string; runningSessionIds?: unknown };
        if (snapshot.type !== "running" || !Array.isArray(snapshot.runningSessionIds)
          || !snapshot.runningSessionIds.every((id) => typeof id === "string")) return;
        onRunning(snapshot.runningSessionIds.length > 0);
      } catch { /* A malformed frame is not proof that all tasks finished. */ }
    };
    current.onerror = () => {
      if (stopped || source !== current || current.readyState !== EventSource.CLOSED) return;
      // CONNECTING errors use EventSource's native retry; CLOSED errors need us.
      current.close();
      source = null;
      reconnectTimer = setTimeout(connect, 5000);
    };
  };
  const recover = () => {
    if (stopped) return;
    // Visibility + focus often arrive together. Reconnect once to repair a
    // half-open stream as well as a known failed connection.
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 100);
  };
  const onVisible = () => { if (document.visibilityState === "visible") recover(); };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);
  window.addEventListener("online", recover);
  connect();
  return () => {
    stopped = true;
    clearTimeout(reconnectTimer);
    source?.close();
    source = null;
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
    window.removeEventListener("online", recover);
  };
}
