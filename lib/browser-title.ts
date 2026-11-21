/** Keep the project title stable, including when Next or native UI writes it. */
export function maintainBrowserTitle(title: string): () => void {
  const sync = () => { if (document.title !== title) document.title = title; };
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}

/** Draw the activity badge onto the app icon as one small PNG. */
function runningIcon(icon: HTMLImageElement): string | undefined {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  const circle = (radius: number, fill: string) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(25, 25, radius, 0, Math.PI * 2);
    ctx.fill();
  };
  ctx.drawImage(icon, 0, 0, 32, 32);
  // At 16px tab size, these radii become the visible badge diameters.
  circle(6.8, "rgba(98, 192, 137, 0.38)");
  circle(5.6, "#244347");
  circle(5, "#91eeb1");
  return canvas.toDataURL("image/png");
}

/**
 * Overlay a still activity badge without editing Next's icons or the PWA icons.
 * Never animate it: Chrome stores every favicon a page shows under the page
 * URL, and a bookmark of that URL repaints from the store, so each frame would
 * flash in the bookmarks bar (and rewrite Chrome's favicon database). One run
 * changes the icon exactly twice: badge on, idle icon back.
 */
export function showRunningFavicon(): () => void {
  const link = document.createElement("link");
  link.rel = "icon";
  link.type = "image/png";
  link.setAttribute("sizes", "32x32");
  const icons = document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]');
  const idle = icons.length ? icons[icons.length - 1].href : "";
  const icon = document.createElement("img");
  let shown = false;
  icon.onload = () => {
    let badge: string | undefined;
    try { badge = runningIcon(icon); } catch { /* Canvas may be blocked. Keep the original icon. */ }
    if (!badge) return;
    link.href = badge;
    document.head.appendChild(link);
    shown = true;
  };
  icon.src = "/icons/icon-192.png";
  return () => {
    icon.onload = null;
    // Some browsers keep the last painted bitmap when a link disappears, so
    // repaint the idle icon before removing the badge link.
    if (shown && idle) link.href = idle;
    link.remove();
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
