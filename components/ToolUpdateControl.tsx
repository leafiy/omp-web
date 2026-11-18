"use client";

import { useEffect, useRef, useState } from "react";
import { isUpdatableTool, TOOL_IDS, TOOL_LABELS, type ToolUpdatesSnapshot, type ToolUpdateStatus, type UpdateTarget } from "@/lib/tool-update-types";
import { InlineConfirmation } from "./InlineConfirmation";

const WATCHED_JOB_KEY = "omp-web:tool-update-job";
const active = (job: ToolUpdateStatus | null | undefined) => job?.phase === "updating" || job?.phase === "restarting";

function available(target: UpdateTarget, snapshot: ToolUpdatesSnapshot | null) {
  return snapshot?.tools.some(t => t.available && (target === "all" || t.tool === target)) ?? false;
}

function validStatus(value: unknown): value is ToolUpdateStatus {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return isUpdatableTool(v.tool) && typeof v.available === "boolean" && typeof v.output === "string"
    && typeof v.phase === "string" && ["idle", "updating", "restarting", "succeeded", "failed"].includes(v.phase)
    && ["id", "unavailableReason", "executable", "installedVersion", "versionError", "previousVersion", "currentVersion", "error", "startedAt", "finishedAt"]
      .every((key) => v[key] === undefined || typeof v[key] === "string")
    && (!["updating", "restarting"].includes(v.phase) || (typeof v.id === "string" && Boolean(v.id)));
}

async function readSnapshot(response: Response): Promise<ToolUpdatesSnapshot> {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error.slice(0, 2000) : `HTTP ${response.status}`);
  if (!body || !Array.isArray(body.tools) || body.tools.length !== TOOL_IDS.length
    || !body.tools.every(validStatus) || !TOOL_IDS.every((id) => body.tools.some((t: ToolUpdateStatus) => t.tool === id))
    || (body.job !== null && !validStatus(body.job))) throw new Error("Invalid software update status");
  return { tools: body.tools, job: body.job ? { ...body.job, output: body.job.output.slice(-16_384) } : null };
}

/** One coordinator for all cards. A lost POST response is resolved by GET, never a retry. */
export function ToolUpdateControl({ zh }: { zh: boolean }) {
  const [snapshot, setSnapshot] = useState<ToolUpdatesSnapshot | null>(null);
  const [checking, setChecking] = useState(true);
  const [submitting, setSubmitting] = useState<UpdateTarget | null>(null);
  const [confirmationTool, setConfirmationTool] = useState<UpdateTarget | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [waitingLong, setWaitingLong] = useState(false);
  const [reloading, setReloading] = useState(false);
  const actions = useRef<{ check: () => void; start: (tool: UpdateTarget) => void } | null>(null);

  useEffect(() => {
    let disposed = false, inFlight = false, connected = false, reloadStarted = false;
    let last: ToolUpdatesSnapshot | null = null;
    let watchedId: string | null = null;
    let waitingSince: number | null = null;
    let pollTimer: number | undefined, requestTimer: number | undefined;
    let controller: AbortController | null = null;
    try { watchedId = sessionStorage.getItem(WATCHED_JOB_KEY); } catch { /* Optional storage. */ }
    if (watchedId) waitingSince = Date.now();

    function watch(id: string | null) {
      watchedId = id;
      try {
        if (id) sessionStorage.setItem(WATCHED_JOB_KEY, id);
        else sessionStorage.removeItem(WATCHED_JOB_KEY);
      } catch { /* Polling still works. */ }
    }
    function waiting() {
      waitingSince ??= Date.now();
      setWaitingLong(Date.now() - waitingSince >= 120_000);
    }
    function schedule() {
      window.clearTimeout(pollTimer);
      if (!disposed && !reloadStarted) pollTimer = window.setTimeout(() => { void check(); }, 2000);
    }
    async function request(tool?: UpdateTarget) {
      const current = new AbortController();
      controller = current;
      requestTimer = window.setTimeout(() => current.abort(), 12_000);
      try {
        return await readSnapshot(await fetch("/api/tools/update", {
          method: tool ? "POST" : "GET", cache: "no-store", signal: current.signal,
          ...(tool ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tool, confirm: true }) } : {}),
        }));
      } finally {
        window.clearTimeout(requestTimer);
        if (controller === current) controller = null;
      }
    }
    function receive(next: ToolUpdatesSnapshot) {
      last = next; connected = true;
      setSnapshot(next); setReconnecting(false); setError(null);
      if (active(next.job)) { watch(next.job!.id!); setSubmissionError(null); waiting(); return true; }
      waitingSince = null; setWaitingLong(false);
      if (next.job?.phase === "succeeded" && next.job.id && next.job.id === watchedId) {
        watch(null); reloadStarted = true; setSubmissionError(null); setReloading(true);
        window.location.reload();
      } else watch(null);
      return false;
    }
    async function check() {
      if (disposed || inFlight || reloadStarted) return;
      window.clearTimeout(pollTimer); inFlight = true; setChecking(true);
      let again = false;
      try {
        const next = await request();
        if (!disposed) again = receive(next);
      } catch (failure) {
        if (!disposed) {
          connected = false; setReconnecting(true);
          setError(failure instanceof Error ? failure.message : String(failure));
          waiting(); again = true;
        }
      } finally {
        inFlight = false;
        if (!disposed) { setChecking(false); if (again) schedule(); }
      }
    }
    async function start(tool: UpdateTarget) {
      if (disposed || inFlight || !connected || reloadStarted || active(last?.job)
        || !available(tool, last)) return;
      window.clearTimeout(pollTimer); inFlight = true;
      setSubmitting(tool); setSubmissionError(null); waitingSince = Date.now(); setWaitingLong(false);
      let again = false;
      try {
        const next = await request(tool);
        if (!disposed) { if (next.job?.id) watch(next.job.id); again = receive(next); }
      } catch (failure) {
        if (!disposed) {
          connected = false; setReconnecting(true);
          setSubmissionError(failure instanceof Error ? failure.message : String(failure));
          waiting(); again = true;
        }
      } finally {
        inFlight = false;
        if (!disposed) { setSubmitting(null); if (again) schedule(); }
      }
    }
    actions.current = { check: () => { void check(); }, start: (tool) => { void start(tool); } };
    void check();
    return () => {
      disposed = true; actions.current = null;
      window.clearTimeout(pollTimer); window.clearTimeout(requestTimer); controller?.abort();
    };
  }, []);

  const job = snapshot?.job;
  const busy = active(job);
  const blocked = checking || submitting !== null || busy || reconnecting || reloading;
  const buttonStyle = { padding: "7px 14px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg-panel)", color: "var(--text)", fontSize: 13 };

  function confirmationMessage(tool: UpdateTarget) {
    if (tool === "all") {
      const names = snapshot?.tools.filter(t => t.available).map(t => TOOL_LABELS[t.tool]).join(", ");
      return zh ? `将依次更新 ${names}，跳过不可用的工具。失败时停止；全部完成后重启一次网页服务，中断运行中的聊天和终端。` : `Update ${names} in order, skipping unavailable tools. Stop on failure; on success, restart the web service once, interrupting running chats and terminals.`;
    }
    const label = TOOL_LABELS[tool];
    return zh
      ? `更新 ${label} 后将重启网页，中断所有运行中的聊天和终端。`
      : `Updating ${label} restarts the web service and interrupts all running chats and terminals.`;
  }

  function confirmUpdate(tool: UpdateTarget) {
    if (!blocked && available(tool, snapshot)) setConfirmationTool(tool);
  }

  return (
    <section aria-labelledby="software-updates-title" aria-busy={checking || submitting !== null || busy}>
      <h3 id="software-updates-title" style={{ margin: "18px 0 6px", fontSize: 15, fontWeight: 600 }}>{zh ? "软件更新" : "Software updates"}</h3>
      <button type="button" disabled={blocked || !available("all", snapshot)} onClick={() => confirmUpdate("all")} style={{ ...buttonStyle, marginBottom: 8 }}>
        {zh ? "一键升级所有可用工具" : "Update all available tools"}
      </button>
      {confirmationTool && <InlineConfirmation key={confirmationTool}
        title={confirmationTool === "all" ? (zh ? "确认升级所有可用工具" : "Confirm update of all available tools") : zh ? `确认更新 ${TOOL_LABELS[confirmationTool]}` : `Confirm ${TOOL_LABELS[confirmationTool]} update`}
        message={confirmationMessage(confirmationTool)} confirmLabel={zh ? "确认更新并重启" : "Confirm update and restart"} cancelLabel={zh ? "取消" : "Cancel"}
        confirmDisabled={blocked || !available(confirmationTool, snapshot)}
        onCancel={() => setConfirmationTool(null)} onConfirm={() => {
          const tool = confirmationTool;
          setConfirmationTool(null);
          if (!blocked && available(tool, snapshot)) actions.current?.start(tool);
        }} />}
      <div style={{ display: "grid", gap: 8 }}>
        {TOOL_IDS.map((tool) => {
          const status = snapshot?.tools.find((t) => t.tool === tool);
          const disabled = blocked || !status?.available;
          const version = status?.versionError ? undefined : status?.installedVersion || status?.currentVersion;
          const running = busy && job?.tool === tool;
          return <div key={tool} style={{ padding: "12px 14px", border: "1px solid var(--border)", borderRadius: 9 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{TOOL_LABELS[tool]}</div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", overflowWrap: "anywhere" }}>{version || (status?.versionError ? (zh ? "版本读取失败" : "Version unavailable") : "—")}</div>
              </div>
              <button type="button" aria-label={zh ? `更新 ${TOOL_LABELS[tool]}` : `Update ${TOOL_LABELS[tool]}`} disabled={disabled} onClick={() => confirmUpdate(tool)} style={{ ...buttonStyle, flexShrink: 0, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? .5 : 1 }}>
                {submitting === tool ? (zh ? "提交中…" : "Starting…") : running ? (zh ? "更新中…" : "Updating…") : (zh ? "更新" : "Update")}
              </button>
            </div>
            {status && !status.available && <details style={{ marginTop: 6, fontSize: 12, color: "var(--text-muted)" }}><summary style={{ cursor: "pointer" }}>{zh ? "暂不能更新 · 查看原因" : "Unavailable · details"}</summary><p style={{ overflowWrap: "anywhere" }}>{status.unavailableReason}</p></details>}
          </div>;
        })}
      </div>
      <div role="status" aria-live="polite" style={{ fontSize: 13, marginTop: 12, color: "var(--text-muted)" }}>
        {reloading ? (zh ? "更新完成，正在刷新网页…" : "Update complete. Reloading…")
          : reconnecting ? (zh ? "正在重新连接…" : "Reconnecting…")
          : !snapshot ? (zh ? "正在读取软件信息…" : "Reading software information…")
          : job?.phase === "updating" ? (zh ? `正在更新 ${TOOL_LABELS[job.tool]}…` : `Updating ${TOOL_LABELS[job.tool]}…`)
          : job?.phase === "restarting" ? (zh ? "软件已更新，等待网页重启…" : "Software updated. Waiting for the web service to restart…")
          : job?.phase === "succeeded" && job.batch ? (zh ? "所有可用工具已更新。" : "All available tools were updated.")
          : job?.phase === "failed" && job.batch && !job.currentVersion ? (zh ? `批量升级在 ${TOOL_LABELS[job.tool]} 处停止，请查看更新日志。` : `Batch update stopped at ${TOOL_LABELS[job.tool]}. See the update log.`)
          : job?.phase === "succeeded" ? (zh ? `${TOOL_LABELS[job.tool]} 上次更新已完成。` : `${TOOL_LABELS[job.tool]} was updated successfully.`)
          : job?.phase === "failed" && job.currentVersion ? (zh ? `${TOOL_LABELS[job.tool]} 已更新，但当时未能确认网页重启。` : `${TOOL_LABELS[job.tool]} was updated, but the web service restart was not confirmed.`)
          : job?.phase === "failed" ? (zh ? "更新失败" : "Update failed")
          : null}
      </div>
      {(waitingLong || reconnecting) && <button type="button" disabled={checking || submitting !== null || reloading} onClick={() => actions.current?.check()} style={{ ...buttonStyle, marginTop: 8, cursor: "pointer" }}>{zh ? "重新连接" : "Reconnect"}</button>}
      {submissionError && !reconnecting && <p role="alert" style={{ fontSize: 13 }}>{zh ? "更新请求未确认" : "Update request not confirmed"}</p>}
      <details style={{ marginTop: 12, fontSize: 12, color: "var(--text-muted)" }}>
        <summary style={{ cursor: "pointer" }}>{zh ? "详细信息和更新日志" : "Details and update log"}</summary>
        {snapshot?.tools.map((tool) => <div key={tool.tool} style={{ overflowWrap: "anywhere" }}>{TOOL_LABELS[tool.tool]}: {tool.executable || "—"}</div>)}
        {snapshot?.tools.filter((tool) => tool.versionError).map((tool) => <p key={tool.tool}>{TOOL_LABELS[tool.tool]}: {tool.versionError}</p>)}
        {job?.previousVersion && <p>{job.previousVersion}{job.currentVersion ? ` → ${job.currentVersion}` : ""}</p>}
        {(submissionError || error || job?.error) && <p role="alert" style={{ overflowWrap: "anywhere" }}>{submissionError || error || job?.error}</p>}
        {job?.output && <pre style={{ maxHeight: 160, overflow: "auto", padding: 10, background: "var(--bg-panel)", borderRadius: 6, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", lineHeight: 1.5 }}>{job.output}</pre>}
      </details>
    </section>
  );
}
