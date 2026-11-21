"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { sendAgentCommand } from "@/lib/agent-client";
import type { WebMcpServer } from "@/lib/claude-mcp";

const STATUS_COLORS: Record<WebMcpServer["status"], string> = {
  connected: "#16a34a",
  failed: "#ef4444",
  "needs-auth": "#d97706",
  pending: "var(--accent)",
  disabled: "var(--text-dim)",
  unknown: "var(--text-dim)",
};

/**
 * Claude Code's native MCP status for one session: reconnect or enable/disable
 * a server for this session. Configuration (commands, URLs, env) stays native
 * and is never sent to the browser; edit it with `claude mcp` in a terminal.
 */
export function ClaudeMcpPanel({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const [servers, setServers] = useState<WebMcpServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await sendAgentCommand<{ servers?: WebMcpServer[] }>(sessionId, { type: "get_mcp_status" });
      setServers(result?.servers ?? []);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [sessionId]);

  useEffect(() => { void load(); }, [load]);

  const act = async (name: string, command: Record<string, unknown>) => {
    setBusy(name);
    setError(null);
    try {
      const result = await sendAgentCommand<{ servers?: WebMcpServer[] }>(sessionId, { ...command, name });
      if (result?.servers) setServers(result.servers);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setBusy(null); }
  };

  const button = { padding: "2px 8px", borderRadius: 5, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 } as const;

  return (
    <div style={{ background: "var(--bg-panel)", borderBottom: "1px solid var(--border)", boxShadow: "0 10px 28px rgba(0,0,0,0.10)", padding: "12px 16px", fontSize: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
        <span style={{ color: "var(--text)", fontWeight: 600 }}>{t("mcp.title")}</span>
        <button type="button" onClick={() => { void load(); }} disabled={busy !== null} style={button}>{t("mcp.refresh")}</button>
      </div>
      {error && <div role="alert" style={{ color: "#ef4444", marginBottom: 8, overflowWrap: "anywhere" }}>{error}</div>}
      {!servers && !error && <div role="status" style={{ color: "var(--text-muted)" }}>{t("mcp.loading")}</div>}
      {servers && servers.length === 0 && <div style={{ color: "var(--text-muted)" }}>{t("mcp.empty")}</div>}
      {servers && servers.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6, maxHeight: "min(480px, 60vh)", overflowY: "auto" }}>
          {servers.map((server) => (
            <li key={server.name} style={{ border: "1px solid var(--border)", borderRadius: 7, padding: "7px 10px", background: "var(--bg)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 4, background: STATUS_COLORS[server.status], flexShrink: 0 }} />
                <span style={{ color: "var(--text)", fontWeight: 600, fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>{server.name}</span>
                <span style={{ color: STATUS_COLORS[server.status] }}>{t(`mcp.status.${server.status}`)}</span>
                <span style={{ color: "var(--text-dim)" }}>{[server.scope, server.transport, server.version && `v${server.version}`].filter(Boolean).join(" · ")}</span>
                <span style={{ flex: 1 }} />
                {server.tools.length > 0 && (
                  <button type="button" onClick={() => setExpanded((current) => current === server.name ? null : server.name)} aria-expanded={expanded === server.name} style={button}>
                    {t("mcp.tools", { count: server.tools.length })}
                  </button>
                )}
                {server.status !== "disabled" && (
                  <button type="button" disabled={busy !== null} onClick={() => { void act(server.name, { type: "mcp_reconnect" }); }} style={button}>
                    {busy === server.name ? t("mcp.working") : t("mcp.reconnect")}
                  </button>
                )}
                <button type="button" disabled={busy !== null} onClick={() => { void act(server.name, { type: "mcp_toggle", enabled: server.status === "disabled" }); }} style={button}>
                  {server.status === "disabled" ? t("mcp.enable") : t("mcp.disable")}
                </button>
              </div>
              {server.error && <div style={{ marginTop: 4, color: "#ef4444", overflowWrap: "anywhere" }}>{server.error}</div>}
              {server.status === "needs-auth" && <div style={{ marginTop: 4, color: "var(--text-muted)" }}>{t("mcp.needsAuth")}</div>}
              {expanded === server.name && (
                <ul style={{ margin: "6px 0 0", padding: "0 0 0 14px", fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.6 }}>
                  {server.tools.map((tool) => (
                    <li key={tool.name} style={{ overflowWrap: "anywhere" }}>
                      {tool.name}{tool.readOnly ? ` · ${t("mcp.readOnly")}` : ""}{tool.destructive ? ` · ${t("mcp.destructive")}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      <div style={{ marginTop: 8, color: "var(--text-dim)", fontSize: 11 }}>{t("mcp.note")}</div>
    </div>
  );
}
