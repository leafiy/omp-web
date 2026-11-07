"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useI18n } from "@/hooks/useI18n";
import { isTerminalId } from "@/lib/terminal-contract";
import { InlineConfirmation } from "./InlineConfirmation";
import styles from "./TerminalPanel.module.css";

const TerminalViewport = dynamic(() => import("./TerminalViewport"), { ssr: false });
export type TerminalStatus = { state: "connecting" | "connected" | "disconnected" | "exited" | "error"; detail?: string };

function newId(): string {
  // randomUUID requires HTTPS; getRandomValues also works on trusted LAN HTTP.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// AppShell keys this by cwd: switching directories detaches, never silently
// changes a running shell's cwd. Returning to a directory reattaches its PTY.
export function TerminalPanel({ cwd }: { cwd: string | null }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [id, setId] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [height, setHeight] = useState(280);
  const [status, setStatus] = useState<TerminalStatus>({ state: "connecting" });
  const [stopping, setStopping] = useState(false);
  const [stopTarget, setStopTarget] = useState<string | null>(null);
  const stoppingRef = useRef(false);
  const drag = useRef<{ y: number; height: number } | null>(null);
  const storageKey = `omp-terminal:${cwd}`;

  useEffect(() => {
    try {
      const stored = Number(localStorage.getItem("omp-terminal-height"));
      if (stored >= 160 && stored <= 700) setHeight(stored);
    } catch { /* storage may be disabled */ }
  }, []);

  function resize(value: number) {
    const next = Math.max(160, Math.min(700, value));
    setHeight(next);
    try { localStorage.setItem("omp-terminal-height", String(next)); } catch { /* optional */ }
  }

  function start() {
    if (!cwd) return;
    let nextId: string | null = null;
    try { nextId = sessionStorage.getItem(storageKey); } catch { /* optional */ }
    if (!isTerminalId(nextId)) nextId = newId();
    try { sessionStorage.setItem(storageKey, nextId); } catch { /* optional */ }
    setStatus({ state: "connecting" });
    setId(nextId);
    setOpen(true);
  }

  async function terminate(target: string) {
    if (!id || target !== id || stoppingRef.current) return;
    stoppingRef.current = true;
    setStopTarget(null);
    setStopping(true);
    try {
      const response = await fetch(`/api/terminal/${target}`, { method: "DELETE" });
      if (!response.ok) throw new Error(t("terminal.stopFailed"));
      try { if (sessionStorage.getItem(storageKey) === target) sessionStorage.removeItem(storageKey); } catch { /* optional */ }
      setId(null);
      setOpen(false);
    } catch (error) {
      setStatus({ state: "error", detail: error instanceof Error ? error.message : String(error) });
    } finally { stoppingRef.current = false; setStopping(false); }
  }

  return (
    <section className={styles.panel} style={{ height: open ? height : stopTarget ? "auto" : 34, maxHeight: open || stopTarget ? "70%" : undefined }} aria-label={t("terminal.title")}>
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
          onClick={() => id ? setOpen(!open) : start()}>
          <span aria-hidden="true">&gt;_</span> {t("terminal.title")} <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        </button>
        <span className={styles.cwd} title={`${t("terminal.initialDirectory")}: ${cwd ?? ""}`}>{cwd}</span>
        {id && <>
          <span className={styles.status} role="status" title={status.detail}>{t(`terminal.${status.state}`)}</span>
          {open && (status.state === "error" || status.state === "disconnected") && <button type="button" onClick={() => {
            setStatus({ state: "connecting" }); setGeneration((value) => value + 1);
          }}>{t("terminal.reconnect")}</button>}
          <button type="button" disabled={stopping} onClick={() => setStopTarget(id)} title={t("terminal.stop")} aria-label={t("terminal.stop")}>×</button>
        </>}
      </div>
      {stopTarget && <div style={{ padding: "0 8px", minHeight: 0, overflow: "auto" }}>
        <InlineConfirmation key={stopTarget} title={t("terminal.stop")} message={t("terminal.confirmStop")}
          confirmLabel={t("terminal.stop")} cancelLabel={t("i18n.cancel")} confirmDisabled={stopping || stopTarget !== id}
          onCancel={() => setStopTarget(null)} onConfirm={() => { void terminate(stopTarget); }} />
      </div>}
      {id && cwd && <div id="workspace-terminal" className={styles.body} style={{ display: open ? "flex" : "none" }}>
        <div className={styles.notice}>{status.detail || t("terminal.notice")}</div>
        <TerminalViewport key={`${id}:${generation}`} id={id} cwd={cwd} onStatus={setStatus} />
      </div>}
    </section>
  );
}
