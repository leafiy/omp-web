"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useI18n } from "@/hooks/useI18n";

const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "6px 9px", fontSize: 13,
  color: "var(--text)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6,
};
const buttonStyle: React.CSSProperties = {
  padding: "5px 12px", fontSize: 13, background: "var(--bg-panel)", color: "var(--text)",
  border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer",
};

/** Web login account: current user, sign-out, and credential changes. */
export function WebAccountSettings() {
  const { t } = useI18n();
  const [username, setUsername] = useState<string | null>(null);
  const [legacy, setLegacy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ username: "", currentPassword: "", newPassword: "", confirmPassword: "" });
  const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);
  const [busy, setBusy] = useState<"save" | "logout" | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/web-auth/status", { cache: "no-store" }).then((response) => response.json()).then((body) => {
      if (cancelled || typeof body?.username !== "string") return;
      setUsername(body.username);
      setLegacy(body.managedByFile === false);
      setForm((current) => ({ ...current, username: body.username }));
    }).catch(() => { /* status is informational */ });
    return () => { cancelled = true; };
  }, []);

  async function logout() {
    setBusy("logout");
    try { await fetch("/api/web-auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); }
    catch { /* the cookie may already be gone; still leave the app */ }
    window.location.replace("/login");
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (form.newPassword.length < 8) { setMessage({ tone: "error", text: t("account.tooShort") }); return; }
    if (form.newPassword !== form.confirmPassword) { setMessage({ tone: "error", text: t("account.mismatch") }); return; }
    setBusy("save");
    setMessage(null);
    try {
      const response = await fetch("/api/web-auth/credentials", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: form.username.trim(), currentPassword: form.currentPassword, newPassword: form.newPassword }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setMessage({ tone: "error", text: typeof body.error === "string" ? body.error : `HTTP ${response.status}` }); return; }
      setUsername(body.username);
      setLegacy(false);
      setForm({ username: body.username, currentPassword: "", newPassword: "", confirmPassword: "" });
      setEditing(false);
      setMessage({ tone: "ok", text: t("account.saved") });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(null); }
  }

  const field = (key: keyof typeof form, label: string, type: string, autoComplete: string) => (
    <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>{label}
      <input style={inputStyle} type={type} autoComplete={autoComplete} required spellCheck={false} value={form[key]}
        onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} />
    </label>
  );

  return (
    <section style={{ marginTop: 16, padding: "12px 14px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{t("account.title")}</div>
          {username && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{t("account.signedInAs", { username })}</div>}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" style={buttonStyle} aria-expanded={editing} onClick={() => { setEditing(!editing); setMessage(null); }}>{t("account.change")}</button>
          <button type="button" style={buttonStyle} disabled={busy !== null} onClick={() => { void logout(); }}>{busy === "logout" ? t("account.loggingOut") : t("account.logout")}</button>
        </div>
      </div>
      {editing && (
        <form onSubmit={save} style={{ display: "grid", gap: 10, marginTop: 12 }}>
          {legacy && <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{t("account.legacy")}</div>}
          {field("username", t("account.newUsername"), "text", "username")}
          {field("currentPassword", t("account.currentPassword"), "password", "current-password")}
          {field("newPassword", t("account.newPassword"), "password", "new-password")}
          {field("confirmPassword", t("account.confirmPassword"), "password", "new-password")}
          <div><button type="submit" style={buttonStyle} disabled={busy !== null}>{busy === "save" ? t("account.saving") : t("account.save")}</button></div>
        </form>
      )}
      {message && <div role={message.tone === "error" ? "alert" : "status"} style={{ marginTop: 10, fontSize: 12, color: message.tone === "error" ? "#ef4444" : "var(--text-muted)" }}>{message.text}</div>}
    </section>
  );
}
