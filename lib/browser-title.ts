/** Keep the project title stable, including when Next or native UI writes it. */
export function maintainBrowserTitle(title: string): () => void {
  const sync = () => { if (document.title !== title) document.title = title; };
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}

/** Render a few small PNGs once. Browsers need not animate SVG/GIF favicons. */
function runningIconFrames(icon: HTMLImageElement): string[] {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  const circle = (radius: number, fill: string) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(25, 25, radius, 0, Math.PI * 2);
    ctx.fill();
  };
  return Array.from({ length: 12 }, (_, i) => {
    const breath = (1 - Math.cos(i * Math.PI / 6)) / 2;
    ctx.clearRect(0, 0, 32, 32);
    ctx.drawImage(icon, 0, 0, 32, 32);
    circle(4 + 2 * breath, `rgba(98, 170, 137, ${0.16 + 0.14 * breath})`);
    circle(3.4, "#244347");
    circle(2.7 + 0.4 * breath, "#83c7a4");
    return canvas.toDataURL("image/png");
  });
}

/** Overlay the activity badge without editing Next's icons or the PWA icons. */
export function showRunningFavicon(): () => void {
  const link = document.createElement("link");
  link.rel = "icon";
  link.type = "image/png";
  link.setAttribute("sizes", "32x32");
  const icon = document.createElement("img");
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let frames: string[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  const animate = () => {
    clearInterval(timer);
    if (!frames.length) return;
    let i = 0;
    link.href = frames[i];
    if (!motion.matches) timer = setInterval(() => {
      i = (i + 1) % frames.length;
      link.href = frames[i];
    }, 220);
  };
  icon.onload = () => {
    try { frames = runningIconFrames(icon); } catch { /* Canvas may be blocked. Keep the original icon. */ }
    if (!frames.length) return;
    animate();
    document.head.appendChild(link);
  };
  motion.addEventListener("change", animate);
  icon.src = "/icons/icon-192.png";
  return () => {
    icon.onload = null;
    motion.removeEventListener("change", animate);
    clearInterval(timer);
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
