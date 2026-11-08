"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useI18n } from "@/hooks/useI18n";
import { isTerminalId } from "@/lib/terminal-contract";
import styles from "./TerminalPanel.module.css";

const TerminalViewport = dynamic(() => import("./TerminalViewport"), { ssr: false });
export type TerminalStatus = { state: "connecting" | "connected" | "disconnected" | "exited" | "error"; detail?: string };
type TerminalTab = { id: string; index: number };

const MAX_TABS = 8;
// Inactive tabs are detached; keep their shells from hitting the server's
// 30-minute detached expiry while this page stays open.
const KEEPALIVE_MS = 5 * 60_000;

function newId(): string {
  // randomUUID requires HTTPS; getRandomValues also works on trusted LAN HTTP.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readStoredTabs(tabsKey: string, legacyKey: string): { tabs: TerminalTab[]; active: string | null } {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(tabsKey) || "null");
    if (parsed && Array.isArray(parsed.tabs)) {
      const tabs = (parsed.tabs as unknown[]).filter((tab): tab is TerminalTab =>
        Boolean(tab) && typeof tab === "object" && isTerminalId((tab as TerminalTab).id) && Number.isInteger((tab as TerminalTab).index),
      ).slice(0, MAX_TABS);
      if (tabs.length) return { tabs, active: tabs.some((tab) => tab.id === parsed.active) ? parsed.active : tabs[0].id };
    }
    // Earlier versions stored a single terminal ID per directory.
    const legacy = sessionStorage.getItem(legacyKey);
    if (isTerminalId(legacy)) return { tabs: [{ id: legacy, index: 1 }], active: legacy };
  } catch { /* storage may be disabled */ }
  return { tabs: [], active: null };
}

// AppShell keys this by cwd: switching directories detaches, never silently
// changes a running shell's cwd. Returning to a directory reattaches its PTYs.
export function TerminalPanel({ cwd }: { cwd: string | null }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [height, setHeight] = useState(280);
  const [statuses, setStatuses] = useState<Record<string, TerminalStatus>>({});
  const [stopping, setStopping] = useState<string | null>(null);
  const drag = useRef<{ y: number; height: number } | null>(null);
  const tabsKey = `omp-terminal-tabs:${cwd}`;
  const legacyKey = `omp-terminal:${cwd}`;
  const status: TerminalStatus = (activeId && statuses[activeId]) || { state: "connecting" };

  useEffect(() => {
    try {
      const stored = Number(localStorage.getItem("omp-terminal-height"));
      if (stored >= 160 && stored <= 700) setHeight(stored);
    } catch { /* storage may be disabled */ }
  }, []);

  useEffect(() => {
    if (!cwd || !tabs.length) return;
    try {
      sessionStorage.setItem(tabsKey, JSON.stringify({ tabs, active: activeId }));
      sessionStorage.removeItem(legacyKey);
    } catch { /* optional */ }
  }, [cwd, tabs, activeId, tabsKey, legacyKey]);

  useEffect(() => {
    const inactive = tabs.filter((tab) => tab.id !== activeId).map((tab) => tab.id);
    if (!inactive.length) return;
    const timer = setInterval(() => {
      for (const id of inactive) {
        void fetch(`/api/terminal/${id}`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "keepalive" }),
        }).catch(() => { /* the tab reconnects (or restarts) when selected */ });
      }
    }, KEEPALIVE_MS);
    return () => clearInterval(timer);
  }, [tabs, activeId]);

  const onStatus = useCallback((next: TerminalStatus) => {
    if (!activeId) return;
    setStatuses((current) => ({ ...current, [activeId]: next }));
  }, [activeId]);

  function resize(value: number) {
    const next = Math.max(160, Math.min(700, value));
    setHeight(next);
    try { localStorage.setItem("omp-terminal-height", String(next)); } catch { /* optional */ }
  }

  function select(id: string) {
    setStatuses((current) => ({ ...current, [id]: { state: "connecting" } }));
    setActiveId(id);
    setOpen(true);
  }

  function addTab(existing: TerminalTab[] = tabs) {
    if (!cwd || existing.length >= MAX_TABS) return;
    const tab = { id: newId(), index: existing.reduce((max, item) => Math.max(max, item.index), 0) + 1 };
    setTabs([...existing, tab]);
    select(tab.id);
  }

  function start() {
    if (!cwd) return;
    const stored = readStoredTabs(tabsKey, legacyKey);
    if (stored.tabs.length && stored.active) {
      setTabs(stored.tabs);
      select(stored.active);
    } else addTab([]);
  }

  // Closing is immediate: no confirmation, per the tab's × button.
  async function closeTab(id: string) {
    if (stopping) return;
    setStopping(id);
    try {
      const response = await fetch(`/api/terminal/${id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(t("terminal.stopFailed"));
      const remaining = tabs.filter((tab) => tab.id !== id);
      setTabs(remaining);
      setStatuses((current) => { const next = { ...current }; delete next[id]; return next; });
      if (!remaining.length) {
        try { sessionStorage.removeItem(tabsKey); sessionStorage.removeItem(legacyKey); } catch { /* optional */ }
        setActiveId(null);
        setOpen(false);
      } else if (id === activeId) {
        const position = tabs.findIndex((tab) => tab.id === id);
        select(remaining[Math.min(position, remaining.length - 1)].id);
      }
    } catch (error) {
      setStatuses((current) => ({ ...current, [id]: { state: "error", detail: error instanceof Error ? error.message : String(error) } }));
    } finally { setStopping(null); }
  }

  const hasTabs = tabs.length > 0 && activeId !== null;
  return (
    <section className={styles.panel} style={{ height: open ? height : 34, maxHeight: open ? "70%" : undefined }} aria-label={t("terminal.title")}>
      {open && <div
        className={styles.resize}
        role="separator" aria-orientation="horizontal" aria-label={t("terminal.resize")}
        aria-valuemin={160} aria-valuemax={700} aria-valuenow={height} tabIndex={0}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          drag.current = { y: e.clientY, height };
          e.currentTarget.setPointerCapture(e.pointerId);
          e.preventDefault();
        }}
        onPointerMove={(e) => { if (drag.current) resize(drag.current.height + drag.current.y - e.clientY); }}
        onPointerUp={(e) => { drag.current = null; e.currentTarget.releasePointerCapture(e.pointerId); }}
        onLostPointerCapture={() => { drag.current = null; }}
        onDoubleClick={() => resize(280)}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Enter") {
            e.preventDefault();
            resize(e.key === "Enter" ? 280 : height + (e.key === "ArrowUp" ? 20 : -20));
          }
        }}
      />}
      <div className={styles.toolbar}>
        <button type="button" aria-expanded={open} aria-controls="workspace-terminal" disabled={!cwd}
          title={cwd ? t("terminal.toggle") : t("terminal.selectDirectory")}
          onClick={() => hasTabs ? setOpen(!open) : start()}>
          <span aria-hidden="true">&gt;_</span> {t("terminal.title")} <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        </button>
        {hasTabs && <div className={styles.tabs} role="tablist" aria-label={t("terminal.title")}>
          {tabs.map((tab) => {
            const label = t("terminal.tab", { index: tab.index });
            const selected = tab.id === activeId;
            return (
              <div key={tab.id} className={styles.tab} data-active={selected || undefined}>
                <button type="button" role="tab" aria-selected={selected} aria-controls="workspace-terminal"
                  className={styles.tabLabel} onClick={() => selected ? setOpen(!open) : select(tab.id)}>{label}</button>
                <button type="button" className={styles.tabClose} disabled={stopping === tab.id}
                  onClick={() => { void closeTab(tab.id); }} title={`${t("terminal.stop")}: ${label}`} aria-label={`${t("terminal.stop")}: ${label}`}>×</button>
              </div>
            );
          })}
          {tabs.length < MAX_TABS && <button type="button" className={styles.tabAdd} onClick={() => addTab()}
            title={t("terminal.newTab")} aria-label={t("terminal.newTab")}>+</button>}
        </div>}
        <span className={styles.cwd} title={`${t("terminal.initialDirectory")}: ${cwd ?? ""}`}>{cwd}</span>
        {hasTabs && <>
          <span className={styles.status} role="status" title={status.detail}>{t(`terminal.${status.state}`)}</span>
          {open && activeId && (status.state === "error" || status.state === "disconnected") && <button type="button" onClick={() => {
            setStatuses((current) => ({ ...current, [activeId]: { state: "connecting" } }));
            setGeneration((value) => value + 1);
          }}>{t("terminal.reconnect")}</button>}
        </>}
      </div>
      {activeId && tabs.length > 0 && cwd && <div id="workspace-terminal" className={styles.body} style={{ display: open ? "flex" : "none" }}>
        {status.detail && <div className={styles.notice}>{status.detail}</div>}
        <TerminalViewport key={`${activeId}:${generation}`} id={activeId} cwd={cwd} onStatus={onStatus} />
      </div>}
    </section>
  );
}
