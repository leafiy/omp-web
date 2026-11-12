"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTranslateStatus } from "@/hooks/useTranslate";
import { loadTranslateStatus, saveTranslateSettings } from "@/lib/translate-client";
import { DEFAULT_TRANSLATE_MODEL } from "@/lib/translate-text";

const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "6px 9px", fontSize: 13,
  color: "var(--text)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6,
};
const buttonStyle: React.CSSProperties = {
  padding: "5px 12px", fontSize: 13, background: "var(--bg-panel)", color: "var(--text)",
  border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer",
};

/** OpenAI-compatible translation API. Without one, no translate buttons are shown. */
export function TranslateSettings() {
  const { t } = useI18n();
  const status = useTranslateStatus();
  const [form, setForm] = useState({ endpoint: "", model: "", apiKey: "" });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "error" | "ok"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadTranslateStatus().then((next) => {
      if (cancelled) return;
      setLoaded(true);
      if (next) setForm({ endpoint: next.endpoint, model: next.model, apiKey: "" });
    });
    return () => { cancelled = true; };
  }, []);

  async function submit(settings: { endpoint: string; model: string; apiKey?: string }) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const next = await saveTranslateSettings(settings);
      setForm({ endpoint: next.endpoint, model: next.model, apiKey: "" });
      setMessage({ tone: "ok", text: next.configured ? t("translate.saved") : t("translate.disabledMessage") });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(false); }
  }

  function save(event: FormEvent) {
    event.preventDefault();
    const apiKey = form.apiKey.trim();
    void submit({ endpoint: form.endpoint.trim(), model: form.model.trim(), ...(apiKey ? { apiKey } : {}) });
  }

  const configured = status?.configured === true;
  return (
    <section style={{ marginTop: 16, padding: "12px 14px", border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{t("translate.settingsTitle")}</div>
        <div style={{ fontSize: 12, color: configured ? "var(--accent)" : "var(--text-dim)" }}>
          {configured ? t("translate.enabled") : t("translate.notConfigured")}
        </div>
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: "var(--text-muted)" }}>{t("translate.settingsHint")}</div>
      <form onSubmit={save} style={{ display: "grid", gap: 10, marginTop: 12 }}>
        <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>{t("translate.endpoint")}
          <input style={inputStyle} type="url" inputMode="url" spellCheck={false} autoComplete="off" disabled={!loaded}
            placeholder="http://host:9940/v1" value={form.endpoint}
            onChange={(event) => setForm((current) => ({ ...current, endpoint: event.target.value }))} />
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>{t("translate.model")}
          <input style={inputStyle} type="text" spellCheck={false} autoComplete="off" disabled={!loaded}
            placeholder={DEFAULT_TRANSLATE_MODEL} value={form.model}
            onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))} />
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 12, color: "var(--text-muted)" }}>{t("translate.apiKey")}
          <input style={inputStyle} type="password" spellCheck={false} autoComplete="new-password" disabled={!loaded}
            placeholder={status?.hasApiKey ? t("translate.apiKeySaved") : t("translate.apiKeyOptional")} value={form.apiKey}
            onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))} />
        </label>
        {configured && status?.url && (
          <div style={{ fontSize: 12, color: "var(--text-dim)", overflowWrap: "anywhere" }}>{t("translate.requestUrl", { url: status.url })}</div>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="submit" style={buttonStyle} disabled={busy || !loaded}>{busy ? t("translate.saving") : t("translate.save")}</button>
          {configured && status?.hasApiKey && (
            <button type="button" style={buttonStyle} disabled={busy}
              onClick={() => { void submit({ endpoint: status.endpoint, model: status.model, apiKey: "" }); }}>{t("translate.removeKey")}</button>
          )}
          {configured && (
            <button type="button" style={buttonStyle} disabled={busy}
              onClick={() => { void submit({ endpoint: "", model: "" }); }}>{t("translate.disable")}</button>
          )}
        </div>
      </form>
      {message && <div role={message.tone === "error" ? "alert" : "status"} style={{ marginTop: 10, fontSize: 12, color: message.tone === "error" ? "#ef4444" : "var(--text-muted)" }}>{message.text}</div>}
    </section>
  );
}
