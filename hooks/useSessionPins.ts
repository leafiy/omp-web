"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionPinSnapshot } from "@/lib/session-pin-state";

/** Server snapshots are authoritative; device-local pins are never imported. */
export function useSessionPins() {
  const [snapshot, setSnapshot] = useState<SessionPinSnapshot>({ revision: -1, pinnedSessionIds: [] });
  const latest = useRef(snapshot);
  const pending = useRef(new Set<string>());
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [pinError, setPinError] = useState(false);

  const applyPinState = useCallback((next: SessionPinSnapshot | undefined) => {
    // In-flight list/poll responses must not undo a newer mutation response.
    if (!next || next.revision <= latest.current.revision) return;
    latest.current = next;
    setSnapshot(next);
  }, []);

  const setPinned = useCallback(async (sessionId: string, pinned: boolean) => {
    if (latest.current.revision < 0 || pending.current.has(sessionId)) return;
    pending.current.add(sessionId);
    setPendingIds(new Set(pending.current));
    try {
      const response = await fetch("/api/sessions/pins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, pinned }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { pinState?: SessionPinSnapshot };
      if (!data.pinState) throw new Error("Missing session pin state");
      applyPinState(data.pinState);
      setPinError(false);
    } catch {
      // Do not move the row until the server has confirmed persistence.
      setPinError(true);
    } finally {
      pending.current.delete(sessionId);
      setPendingIds(new Set(pending.current));
    }
  }, [applyPinState]);

  const togglePin = useCallback((id: string) => {
    void setPinned(id, !latest.current.pinnedSessionIds.includes(id));
  }, [setPinned]);

  useEffect(() => {
    // Importing an old device list could resurrect pins removed elsewhere.
    try { window.localStorage.removeItem("omp-web:pinned-sessions"); } catch { /* private mode */ }
  }, []);

  return {
    pinnedSessionIds: snapshot.pinnedSessionIds,
    applyPinState,
    togglePin,
    setPinned,
    isPinDisabled: (id: string) => snapshot.revision < 0 || pendingIds.has(id),
    pinError,
  };
}
