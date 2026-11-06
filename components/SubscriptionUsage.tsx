"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { engineLabel } from "@/lib/engine";
import type { AgentUsage, UsageOverview } from "@/lib/usage-types";

export function SubscriptionUsage({ sessionId, onClose }: { sessionId?: string; onClose: () => void }) {
  const { locale } = useI18n(), zh = locale === "zh-CN";
  const [data, setData] = useState<UsageOverview | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState(false);
  const refresh = useRef<() => void>(() => {});
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    let disposed = false, pending = false; let controller: AbortController | undefined;
    async function load(force = false) {
      if (pending || disposed) return; pending = true; setBusy(true); setError(false);
      controller = new AbortController(); const timer = setTimeout(() => controller?.abort(), 25_000);
      const params = new URLSearchParams({ ...(sessionId ? { sessionId } : {}), ...(force ? { refresh: "1" } : {}) });
      try {
        const response = await fetch(`/api/usage?${params}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Usage request failed");
        const result = await response.json() as UsageOverview;
        if (!Array.isArray(result.subscriptions)) throw new Error("Invalid usage response");
        if (!disposed) setData(result);
      } catch { if (!disposed) setError(true); }
      finally { clearTimeout(timer); pending = false; if (!disposed) setBusy(false); }
    }
    refresh.current = () => { void load(true); };
    void load();
    const interval = setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => { disposed = true; controller?.abort(); clearInterval(interval); };
  }, [sessionId]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
      if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
    };
    document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  const buttonStyle = { padding: "6px 12px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", color: "var(--text)", fontSize: 13, cursor: "pointer" };
  function count(value: string | null) { try { return value === null ? (zh ? "未提供" : "Not provided") : new Intl.NumberFormat(locale).format(BigInt(value)); } catch { return zh ? "未提供" : "Not provided"; } }
  function card(report: AgentUsage, session = false) {
    return <section key={session ? "session" : report.engine} style={{ border: "1px solid var(--border)", borderRadius: 9, padding: 16, marginTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{engineLabel(report.engine)}{session ? (zh ? " · 当前会话" : " · Current session") : ""}</h3>
        {report.plan && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{({ max: "Max", pro: "Pro", plus: "Plus", prolite: "Pro Lite", team: "Team", business: "Business", enterprise: "Enterprise", free: "Free" } as Record<string, string>)[report.plan] || report.plan}</span>}
      </div>
      {!session && <>
        <p style={{ margin: "12px 0 6px", color: "var(--text-muted)", fontSize: 12 }}>{zh ? "订阅周剩余" : "Weekly quota remaining"}</p>
        {report.weekly.length ? report.weekly.map((w, i) => <div key={i} style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: 13, overflowWrap: "anywhere" }}>{w.name}</span>
            <strong style={{ fontSize: 22, fontVariantNumeric: "tabular-nums" }}>{w.remainingPercent.toFixed(1)}%</strong>
          </div>
          <div style={{ height: 5, background: "var(--bg-hover)", borderRadius: 3, margin: "5px 0" }}><div style={{ height: "100%", width: `${w.remainingPercent}%`, borderRadius: 3, background: "var(--accent)" }} /></div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{w.resetsAt ? `${zh ? "重置：" : "Resets: "}${new Date(w.resetsAt).toLocaleString(locale)}` : (zh ? "未提供重置时间" : "Reset time not provided")}</div>
        </div>) : <div style={{ fontSize: 20, marginBottom: 10 }}>{zh ? "未提供" : "Not provided"}</div>}
        {report.ordinaryUsageAllowed === false && <p style={{ fontSize: 12 }}>{zh ? "原生服务报告：当前普通额度暂不可用。" : "Native service reports ordinary included usage is currently unavailable."}</p>}
      </>}
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{report.tokenScope === "session" ? (zh ? "本会话总 Token" : "Session total tokens") : (zh ? "总 Token" : "Total tokens")}</div>
        <div style={{ fontSize: 24, fontWeight: 600, fontVariantNumeric: "tabular-nums", overflowWrap: "anywhere" }}>{count(report.totalTokens)}</div>
        {report.tokenScope === "account" && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{zh ? "账号累计 · 原生接口返回" : "Account lifetime · reported by the native CLI"}</div>}
      </div>
      <p style={{ margin: "10px 0 4px", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>{zh ? report.note : report.noteEn || report.note}</p>
      <span style={{ fontSize: 11, color: "var(--text-dim)" }}>{zh ? "读取于 " : "Read at "}{new Date(report.checkedAt).toLocaleTimeString(locale)}</span>
    </section>;
  }
  return <div onClick={e => { if (e.target === e.currentTarget) onClose(); }} style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,.45)", display: "grid", placeItems: "center", padding: 16 }}>
    <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby="subscription-usage-title" aria-busy={busy} style={{ width: "100%", maxWidth: 620, maxHeight: "90dvh", overflow: "auto", background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h2 id="subscription-usage-title" style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{zh ? "订阅用量" : "Subscription usage"}</h2>
        <div style={{ display: "flex", gap: 8 }}><button type="button" disabled={busy} onClick={() => refresh.current()} style={buttonStyle}>{busy ? (zh ? "读取中…" : "Loading…") : (zh ? "刷新" : "Refresh")}</button><button type="button" autoFocus onClick={onClose} style={buttonStyle}>{zh ? "关闭" : "Close"}</button></div>
      </header>
      <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>{zh ? "读取本机已登录订阅，不保存登录凭据。" : "Reads this machine’s native subscriptions without storing credentials."}</p>
      {error && <p role="alert" style={{ fontSize: 13 }}>{zh ? "暂时无法读取用量，请稍后刷新；没有把未知数据当成 0。" : "Usage could not be read. Refresh later; unknown usage is not treated as zero."}</p>}
      {!data && busy && <p role="status">{zh ? "正在向原生工具查询…" : "Querying native tools…"}</p>}
      {data?.subscriptions.map(r => card(r))}
      {data?.session && card(data.session, true)}
      <details style={{ marginTop: 14, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>
        <summary style={{ cursor: "pointer" }}>{zh ? "统计范围与说明" : "Scope and details"}</summary>
        <p>{zh ? "OMP/Pi 未提供订阅周额度接口，不能用另一工具的登录代替。当前对话可用时，另列会话 Token。周额度按服务商周期重置，不一定是自然周，也不能直接换算成 Token。数据最多缓存约一分钟，实际可用状态以原生工具提示为准。" : "OMP/Pi expose no subscription-quota RPC; another tool’s login is not substituted. Session tokens appear separately when available. Provider reset windows are not necessarily calendar weeks and cannot be converted into a fixed token allowance. Results are cached for about a minute; native tools determine actual availability."}</p>
      </details>
    </section>
  </div>;
}
