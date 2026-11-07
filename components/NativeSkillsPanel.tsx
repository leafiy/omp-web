"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { engineLabel, parseEngine, type AgentEngine } from "@/lib/engine";
import type { NativeSkillsReport } from "@/lib/native-skills-types";

export function NativeSkillsPanel({ engine, cwd, onClose, installedEngines }: { engine: AgentEngine; cwd: string | null; onClose: () => void; installedEngines: Partial<Record<AgentEngine, boolean>> }) {
  const { locale } = useI18n(), zh = locale === "zh-CN";
  const [selected, setSelected] = useState(engine);
  const [data, setData] = useState<{ key: string; report: NativeSkillsReport } | null>(null);
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState("");
  const refresh = useRef<() => void>(() => {}), dialog = useRef<HTMLElement>(null);
  const key = `${selected}\0${cwd ?? ""}`;
  const report = data?.key === key ? data.report : null;
  useEffect(() => {
    let disposed = false, pending = false;
    let controller: AbortController | undefined;
    setData(null); setFailed(false);
    async function load(force = false) {
      if (!cwd || disposed || pending) return;
      pending = true; setBusy(true); setFailed(false); setData(null);
      controller = new AbortController(); const timer = setTimeout(() => controller?.abort(), 25_000);
      try {
        const params = new URLSearchParams({ engine: selected, cwd, ...(force ? { refresh: "1" } : {}) });
        const response = await fetch(`/api/native-skills?${params}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Skills request failed");
        const result = await response.json() as NativeSkillsReport;
        if (result.engine !== selected || !Array.isArray(result.items) || !["ok", "partial", "unavailable", "error"].includes(result.status)) throw new Error("Invalid skills response");
        if (!disposed) setData({ key, report: result });
      } catch { if (!disposed) setFailed(true); }
      finally { clearTimeout(timer); pending = false; if (!disposed) setBusy(false); }
    }
    refresh.current = () => { void load(true); };
    if (cwd) void load(); else setBusy(false);
    return () => { disposed = true; controller?.abort(); };
  }, [selected, cwd, key]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select, input') ?? []);
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); if (previous?.isConnected) previous.focus(); };
  }, [onClose]);
  const controls = { padding: "6px 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", color: "var(--text)", fontSize: 13 };
  const items = report?.items.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(filter.toLowerCase())) ?? [];
  return <div onClick={(event) => { if (event.target === event.currentTarget) onClose(); }} style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,.45)", display: "grid", placeItems: "center", padding: 16 }}>
    <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="native-skills-title" aria-busy={busy} style={{ width: "100%", maxWidth: 680, maxHeight: "90dvh", overflow: "auto", background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <h2 id="native-skills-title" style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{zh ? "技能" : "Skills"}</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" disabled={busy || !cwd} onClick={() => refresh.current()} style={controls}>{busy ? (zh ? "读取中…" : "Loading…") : (zh ? "刷新" : "Refresh")}</button>
          <button type="button" autoFocus onClick={onClose} style={controls}>{zh ? "关闭" : "Close"}</button>
        </div>
      </header>
      <label style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13 }}>{zh ? "Agent" : "Agent"}
        <select aria-label={zh ? "技能所属 Agent" : "Skills agent"} value={selected} onChange={(event) => { const next = parseEngine(event.target.value); if (installedEngines[next] === true) { setSelected(next); setFilter(""); } }} style={controls}>
          {(["omp", "pi", "claude", "codex"] as const).map((item) => <option key={item} value={item} disabled={installedEngines[item] !== true}>{engineLabel(item)}{installedEngines[item] === false ? (zh ? "（未安装）" : " (not installed)") : installedEngines[item] !== true ? (zh ? "（检测中）" : " (checking)") : ""}</option>)}
        </select>
      </label>
      {!cwd ? <p role="status">{zh ? "请选择项目" : "Select a project"}</p> : <>
        <details style={{ margin: "10px 0", fontSize: 12, color: "var(--text-muted)", overflowWrap: "anywhere" }}><summary>{zh ? "当前项目" : "Current project"}</summary><code>{cwd}</code></details>
        {busy && <p role="status">{zh ? "正在读取原生目录…" : "Reading native catalog…"}</p>}
        {failed && <p role="alert">{zh ? "技能读取失败" : "Could not load skills"}</p>}
        {report && <>
          {["error", "unavailable"].includes(report.status) && <p role="alert">{zh ? "技能不可用" : "Skills unavailable"}</p>}
          {report.items.length > 0 && <input aria-label={zh ? "筛选技能" : "Filter skills"} value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={zh ? "搜索技能" : "Search skills"} style={{ ...controls, width: "100%", marginBottom: 10 }} />}
          {items.map((item, index) => <article key={`${item.name}:${item.path ?? index}`} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, marginBottom: 8, overflowWrap: "anywhere" }}>
            <strong style={{ fontSize: 14 }}>{item.name}</strong>
            <span style={{ marginLeft: 8, color: "var(--text-dim)", fontSize: 11 }}>{item.kind === "command" ? (zh ? "技能 / 自定义命令" : "Skill / custom command") : (zh ? "技能" : "Skill")}{item.enabled === false ? (zh ? " · 已禁用" : " · Disabled") : item.enabled === true ? (zh ? " · 已启用" : " · Enabled") : ""}</span>
            {item.invocation && <code style={{ fontSize: 12 }}>{item.invocation}</code>}
            {item.path && <details style={{ marginTop: 6, fontSize: 11, color: "var(--text-muted)" }}><summary>{zh ? "原生路径" : "Native path"}</summary><code>{item.path}</code></details>}
          </article>)}
          {!items.length && ["ok", "partial"].includes(report.status) && <p style={{ fontSize: 13 }}>{filter ? (zh ? "没有匹配的技能。" : "No matching skills.") : (zh ? "暂无技能" : "No skills")}</p>}
        </>}
      </>}
    </section>
  </div>;
}
