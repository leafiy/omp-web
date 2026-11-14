"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionReadSnapshot } from "@/lib/session-read-state";

/** Server receipts are authoritative; never import legacy device-local dots. */
export function useSessionReadState(selectedSessionId: string | null) {
  const [snapshot, setSnapshot] = useState<SessionReadSnapshot>({ revision: -1, unread: {} });
  const latest = useRef(snapshot);
  const pending = useRef(new Set<string>());
  const [readError, setReadError] = useState(false);
  const applyReadState = useCallback((next: SessionReadSnapshot | undefined) => {
    if (!next || next.revision < latest.current.revision) return;
    latest.current = next;
    setSnapshot(next);
  }, []);

  const markSessionsRead = useCallback(async (ids: string[]) => {
    const entries = ids.flatMap(id => {
      const version = latest.current.unread[id];
      return version && !pending.current.has(`${id}:${version}`) ? [[id, version] as const] : [];
    });
    if (!entries.length) return;
    const keys = entries.map(([id, version]) => `${id}:${version}`);
    keys.forEach(key => pending.current.add(key));
    try {
      const response = await fetch("/api/sessions/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receipts: Object.fromEntries(entries) }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { readState: SessionReadSnapshot };
      applyReadState(data.readState);
      setReadError(false);
    } catch {
      // Keep the dot, and retry the selected chat on the next poll.
      setReadError(true);
    } finally {
      keys.forEach(key => pending.current.delete(key));
    }
  }, [applyReadState]);

  useEffect(() => {
    const acknowledgeVisible = () => {
      if (selectedSessionId && document.visibilityState === "visible") void markSessionsRead([selectedSessionId]);
    };
    acknowledgeVisible();
    document.addEventListener("visibilitychange", acknowledgeVisible);
    return () => document.removeEventListener("visibilitychange", acknowledgeVisible);
  }, [selectedSessionId, snapshot, markSessionsRead]);

  useEffect(() => {
    // Old booleans have no completion identity and cannot be migrated safely:
    // importing them would resurrect activity already read on another device.
    try { window.localStorage.removeItem("omp-web:unread-session-ids"); } catch { /* private mode */ }
  }, []);

  return { unreadSessionIds: new Set(Object.keys(snapshot.unread)), applyReadState, markSessionsRead, readError };
}
