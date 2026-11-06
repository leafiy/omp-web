"use client";

import { useEffect, useRef, useState } from "react";
import type { OmpUpdateStatus } from "@/lib/omp-update-types";

const WATCHED_JOB_KEY = "omp-web:omp-update-job";
const POLL_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 12_000;
const WAIT_NOTICE_MS = 120_000;
const MAX_LOG_CHARS = 16_384;

function isActive(status: OmpUpdateStatus) {
  return status.phase === "updating" || status.phase === "restarting";
}

function isUpdateStatus(value: unknown): value is OmpUpdateStatus {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.available === "boolean"
    && typeof record.phase === "string"
    && ["idle", "updating", "restarting", "succeeded", "failed"].includes(record.phase)
    && typeof record.output === "string"
    && ["unavailableReason", "id", "previousVersion", "currentVersion", "startedAt", "finishedAt", "error"]
      .every((key) => record[key] === undefined || typeof record[key] === "string")
    && (!["updating", "restarting"].includes(record.phase) || (typeof record.id === "string" && record.id.length > 0));
}

async function readStatus(response: Response): Promise<OmpUpdateStatus> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error.slice(0, 2_000)
      : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  if (!isUpdateStatus(body)) throw new Error(`HTTP ${response.status}: invalid OMP update status`);
  return { ...body, output: body.output.slice(-MAX_LOG_CHARS) };
}

/** Owns one GET/POST workflow; closing this view never cancels the server's update. */
export function OmpUpdateControl({ zh }: { zh: boolean }) {
  const [status, setStatus] = useState<OmpUpdateStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [waitingLong, setWaitingLong] = useState(false);
  const [reloading, setReloading] = useState(false);
  const actions = useRef<{ check: () => void; start: () => void } | null>(null);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let connected = false;
    let lastStatus: OmpUpdateStatus | null = null;
    let watchedId: string | null = null;
    let waitingSince: number | null = null;
    let reloadStarted = false;
    let pollTimer: number | undefined;
    let requestTimer: number | undefined;
    let controller: AbortController | null = null;
    try { watchedId = sessionStorage.getItem(WATCHED_JOB_KEY); } catch { /* Storage is optional. */ }
    if (watchedId) waitingSince = Date.now();

    function watch(id: string | null) {
      watchedId = id;
      try {
        if (id) sessionStorage.setItem(WATCHED_JOB_KEY, id);
        else sessionStorage.removeItem(WATCHED_JOB_KEY);
      } catch { /* Polling and one-time reload still work without storage. */ }
    }

    function cancelPoll() {
      window.clearTimeout(pollTimer);
      pollTimer = undefined;
    }

    function scheduleCheck(delay = POLL_INTERVAL_MS) {
      cancelPoll();
      if (!disposed && !reloadStarted) pollTimer = window.setTimeout(() => { void check(); }, delay);
    }

    function noteWaiting() {
      waitingSince ??= Date.now();
      setWaitingLong(Date.now() - waitingSince >= WAIT_NOTICE_MS);
    }

    async function request(method: "GET" | "POST") {
      const current = new AbortController();
      controller = current;
      requestTimer = window.setTimeout(() => current.abort(), REQUEST_TIMEOUT_MS);
      try {
        return await readStatus(await fetch("/api/omp/update", {
          method,
          cache: "no-store",
          signal: current.signal,
          ...(method === "POST" ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ confirm: true }),
          } : {}),
        }));
      } finally {
        window.clearTimeout(requestTimer);
        requestTimer = undefined;
        if (controller === current) controller = null;
      }
    }

    function receive(next: OmpUpdateStatus) {
      lastStatus = next;
      connected = true;
      setStatus(next);
      setReconnecting(false);
      setStatusError(null);
      if (isActive(next)) {
        watch(next.id!);
        noteWaiting();
        setSubmissionError(null);
        return true;
      }
      waitingSince = null;
      setWaitingLong(false);
      // Only a job observed in flight (or accepted by our POST) may reload this tab.
      // Consume its ID before reload so an old succeeded record cannot cause a loop.
      if (next.phase === "succeeded" && next.id && next.id === watchedId) {
        watch(null);
        reloadStarted = true;
        setSubmissionError(null);
        setReloading(true);
        window.location.reload();
      } else {
        watch(null);
      }
      return false;
    }

    async function check() {
      if (disposed || inFlight || reloadStarted) return;
      cancelPoll();
      inFlight = true;
      setChecking(true);
      let again = false;
      try {
        const next = await request("GET");
        if (disposed) return;
        again = receive(next);
      } catch (error) {
        if (disposed) return;
        connected = false;
        setReconnecting(true);
        setStatusError(error instanceof Error ? error.message : null);
        noteWaiting();
        again = true;
      } finally {
        inFlight = false;
        if (!disposed) {
          setChecking(false);
          if (again) scheduleCheck();
        }
      }
    }

    async function start() {
      if (disposed || inFlight || !connected || !lastStatus?.available || isActive(lastStatus) || reloadStarted) return;
      cancelPoll();
      inFlight = true;
      setSubmitting(true);
      setSubmissionError(null);
      waitingSince = Date.now();
      setWaitingLong(false);
      let again = false;
      try {
        const next = await request("POST");
        if (disposed) return;
        if (next.id) watch(next.id);
        again = receive(next);
      } catch (error) {
        if (disposed) return;
        // The server may have accepted the request before the connection closed.
        // Resolve that uncertainty with GET only, never by resending the POST.
        connected = false;
        setReconnecting(true);
        setSubmissionError(error instanceof Error ? error.message : "HTTP request interrupted");
        noteWaiting();
        again = true;
      } finally {
        inFlight = false;
        if (!disposed) {
          setSubmitting(false);
          if (again) scheduleCheck();
        }
      }
    }

    actions.current = { check: () => { void check(); }, start: () => { void start(); } };
    void check();
    return () => {
      disposed = true;
      actions.current = null;
      cancelPoll();
      window.clearTimeout(requestTimer);
      controller?.abort();
    };
  }, []);

  const active = status !== null && isActive(status);
  const disabled = !status?.available || checking || submitting || active || reconnecting || reloading;
  const phaseLabel = status ? {
    idle: status.available ? (zh ? "可以更新本机 OMP。" : "Ready to update local OMP.") : (zh ? "当前无法启动更新。" : "Updating is currently unavailable."),
    updating: zh ? "正在下载并更新本机 OMP…" : "Downloading and updating local OMP…",
    restarting: zh ? "OMP 已更新，正在等待网页服务重启并重新连接…" : "OMP is updated; waiting for the web service to restart and reconnect…",
    succeeded: zh ? "最近一次 OMP 更新已完成。" : "The latest OMP update completed.",
    failed: zh ? "OMP 更新未完成，请查看错误和日志。" : "The OMP update did not complete. See the error and log below.",
  }[status.phase] : null;
  const buttonStyle = {
    padding: "7px 12px", border: "1px solid var(--border)", borderRadius: 6,
    background: "var(--bg-panel)", color: "var(--text)", fontSize: 13,
  };

  function confirmUpdate() {
    if (disabled) return;
    const message = zh
      ? "将下载并更新这台主机上的 OMP，然后自动重启网页服务。\n\n这会中断所有网页聊天任务和内嵌终端（包括其他用户），未落盘内容可能丢失，请先结束任务、保存工作。配置、凭据和已保存的会话历史会保留；运行中的任务不会自动恢复。不会更新 omp-web 本身。\n\n现在更新并重启？"
      : "Download and update OMP on this host, then automatically restart the web service?\n\nThis interrupts ALL web chat tasks and embedded terminals, including other users' work. Unsaved data may be lost; finish tasks and save your work first. Configuration, credentials and saved session history are preserved; running tasks will not resume automatically. This does not update omp-web itself.\n\nUpdate and restart now?";
    if (window.confirm(message)) actions.current?.start();
  }

  return (
    <section aria-labelledby="omp-update-title" aria-busy={checking || submitting || active} style={{ margin: "20px 0", paddingTop: 16, borderTop: "1px solid var(--border)" }}>
      <h3 id="omp-update-title" style={{ margin: "0 0 8px", fontSize: 15, fontWeight: 600 }}>{zh ? "更新本机 OMP" : "Update local OMP"}</h3>
      <p style={{ margin: "0 0 10px", fontSize: 13, color: "var(--text-muted)" }}>
        {zh ? "使用官方更新命令，然后重启网页服务；会中断所有网页任务和终端。保留配置、凭据和已保存的历史，不更新 omp-web 本身。关闭此面板不会停止更新。" : "Uses the official updater, then restarts the web service, interrupting all web tasks and terminals. Keeps configuration, credentials and saved history; does not update omp-web itself. Closing this panel does not stop the update."}
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <button type="button" disabled={disabled} onClick={confirmUpdate} style={{ ...buttonStyle, opacity: disabled ? 0.55 : 1, cursor: disabled ? "not-allowed" : "pointer" }}>
          {submitting ? (zh ? "正在提交…" : "Submitting…") : active ? (zh ? "更新 / 重启进行中…" : "Update / restart in progress…") : (zh ? "更新 OMP 并重启" : "Update OMP and restart")}
        </button>
        <button type="button" disabled={checking || submitting || reloading} onClick={() => actions.current?.check()} style={{ ...buttonStyle, opacity: checking || submitting || reloading ? 0.55 : 1, cursor: checking || submitting || reloading ? "not-allowed" : "pointer" }}>
          {checking ? (zh ? "读取状态中…" : "Checking status…") : (zh ? "重新读取状态" : "Retry status check")}
        </button>
      </div>
      <div role="status" aria-live="polite" style={{ fontSize: 13 }}>
        {reloading ? (zh ? "服务器已确认本次更新完成，正在刷新网页…" : "The server confirmed this update completed. Reloading the page…") : reconnecting ? (
          <p style={{ margin: "6px 0" }}>{status
            ? (zh ? "暂时无法确认服务器状态，正在重新连接；尚未确认更新完成，不会自动重发更新请求。" : "Cannot confirm server status yet. Reconnecting; completion is not confirmed and the update request will not be resent automatically.")
            : (zh ? "无法读取首次更新状态，在成功读取前禁止启动更新；正在重试。" : "Cannot read the initial update status. Updating is disabled until a status check succeeds; retrying.")}</p>
        ) : phaseLabel ? <p style={{ margin: "6px 0" }}>{phaseLabel}</p> : <p style={{ margin: "6px 0" }}>{zh ? "正在读取更新状态…" : "Reading update status…"}</p>}
        {status && (status.previousVersion || status.currentVersion) && <p style={{ margin: "6px 0", overflowWrap: "anywhere", color: "var(--text-muted)" }}>
          {zh ? "OMP 版本：" : "OMP version: "}{status.previousVersion}{status.previousVersion && status.currentVersion && status.previousVersion !== status.currentVersion ? " → " : ""}{status.currentVersion !== status.previousVersion ? status.currentVersion : ""}
        </p>}
        {status && !status.available && <p style={{ margin: "6px 0", overflowWrap: "anywhere", color: "var(--text-muted)" }}>{zh ? "更新不可用：" : "Update unavailable: "}{status.unavailableReason || (zh ? "服务器未启用此功能。" : "This feature is not enabled on the server.")}</p>}
      </div>
      {submissionError && <p role="alert" style={{ margin: "8px 0", fontSize: 13, overflowWrap: "anywhere" }}>
        {reconnecting || checking
          ? (zh ? "更新请求未获确认，正在重新读取状态；不会自动重发。" : "The update request was not confirmed. Rechecking status without automatically resending it.")
          : (zh ? "更新请求未获确认；状态已重新读取，未自动重发。" : "The update request was not confirmed. Status was checked again; the request was not automatically resent.")}
        {" "}{submissionError}
      </p>}
      {reconnecting && statusError && <p style={{ margin: "8px 0", fontSize: 12, overflowWrap: "anywhere", color: "var(--text-muted)" }}>{zh ? "状态读取错误：" : "Status check error: "}{statusError}</p>}
      {status?.phase === "failed" && <p role="alert" style={{ margin: "8px 0", fontSize: 13, overflowWrap: "anywhere" }}>{status.error || (zh ? "服务器报告更新失败，请查看日志后重试。" : "The server reported an update failure. Review the log before trying again.")}</p>}
      {(waitingLong || (status?.phase === "succeeded" && submissionError)) && <p style={{ margin: "8px 0", fontSize: 13 }}>
        {zh ? "尚未自动刷新；可以手动刷新网页以重新读取服务器状态。刷新不会重新提交更新，未确认完成时仍会继续轮询。" : "The page has not reloaded automatically. You can refresh it to read server status again. Refreshing does not resubmit the update; polling continues while completion is unconfirmed."}
        {" "}<button type="button" onClick={() => window.location.reload()} style={{ ...buttonStyle, cursor: "pointer" }}>{zh ? "手动刷新网页" : "Refresh page"}</button>
      </p>}
      {status?.output && <details open={active || status.phase === "failed"} style={{ marginTop: 10, fontSize: 12 }}>
        <summary style={{ cursor: "pointer", color: "var(--text-muted)" }}>{zh ? "更新日志（最多显示末尾 16,384 个字符）" : "Update log (last 16,384 characters at most)"}</summary>
        <pre style={{ maxHeight: 180, overflow: "auto", padding: 10, background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.5 }}>{status.output}</pre>
      </details>}
    </section>
  );
}
