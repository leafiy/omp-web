"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useI18n } from "@/hooks/useI18n";

type Status = { configured: boolean; invalid: boolean; authenticated: boolean };

const SETUP_COMMAND = "node ~/code/omp-web/bin/omp-web.js passwd";

const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "9px 11px", fontSize: 14,
  color: "var(--text)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 7, outline: "none",
};
const labelStyle: React.CSSProperties = { display: "grid", gap: 6, fontSize: 12, color: "var(--text-muted)" };

/** Minimal login page; credentials are checked by /api/web-auth/login. */
export function LoginForm() {
  const { t } = useI18n();
  const [status, setStatus] = useState<Status | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/web-auth/status", { cache: "no-store" })
      .then((response) => response.json())
      .then((body: Status) => {
        if (cancelled) return;
        if (body.authenticated) window.location.replace("/");
        else setStatus(body);
      })
      .catch(() => { if (!cancelled) setStatus({ configured: true, invalid: false, authenticated: false }); });
    return () => { cancelled = true; };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/web-auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (response.ok) { window.location.replace("/"); return; }
      const body = await response.json().catch(() => ({}));
      if (response.status === 503) setStatus({ configured: false, invalid: body.code === "invalid", authenticated: false });
      setError(response.status === 429 ? t("login.rateLimited") : response.status === 401 ? t("login.invalid") : t("login.failed"));
      setPassword("");
    } catch {
      setError(t("login.failed"));
    } finally { setSubmitting(false); }
  }

  const unavailable = Boolean(status && !status.configured);
  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 20, background: "var(--bg)", color: "var(--text)" }}>
      <section style={{ width: "100%", maxWidth: 340, padding: "28px 24px", border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-panel)" }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--accent)", letterSpacing: 0.5, marginBottom: 6 }}>OMP WEB</div>
        <h1 style={{ margin: "0 0 20px", fontSize: 18, fontWeight: 600 }}>{t("login.title")}</h1>
        {unavailable ? (
          <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--text-muted)" }}>
            <p style={{ margin: "0 0 10px" }}>{status?.invalid ? t("login.invalidConfig") : t("login.notConfigured")}</p>
            <code style={{ display: "block", padding: "8px 10px", borderRadius: 6, background: "var(--bg)", border: "1px solid var(--border)", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text)", overflowWrap: "anywhere" }}>{SETUP_COMMAND}</code>
          </div>
        ) : (
          <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
            <label style={labelStyle}>{t("login.username")}
              <input style={inputStyle} name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus required
                value={username} onChange={(event) => setUsername(event.target.value)} />
            </label>
            <label style={labelStyle}>{t("login.password")}
              <input style={inputStyle} name="password" type="password" autoComplete="current-password" required
                value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
            {error && <div role="alert" style={{ fontSize: 12, color: "#ef4444" }}>{error}</div>}
            <button type="submit" disabled={submitting || !username || !password} style={{
              marginTop: 4, padding: "9px 12px", fontSize: 14, fontWeight: 600, borderRadius: 7, border: "1px solid var(--accent)",
              background: "var(--accent)", color: "#fff", cursor: submitting ? "default" : "pointer", opacity: submitting || !username || !password ? 0.6 : 1,
            }}>{submitting ? t("login.submitting") : t("login.submit")}</button>
          </form>
        )}
      </section>
    </main>
  );
}
