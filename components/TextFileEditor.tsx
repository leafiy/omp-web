"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { TEXT_PREVIEW_MAX_BYTES } from "@/lib/file-types";

interface Props {
  path: string; url: string; content: string; version: string; language: string;
  onClose: (saved: boolean) => void;
}

export function TextFileEditor({ path, url, content, version, language, onClose }: Props) {
  const { t } = useI18n();
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  const original = content.slice(bom.length).replace(/\r\n/g, "\n");
  const [draft, setDraft] = useState(original);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const active = useRef<AbortController | null>(null);
  const dirty = draft !== original;
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function submit(action: "edit" | "format") {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true); setError("");
    try {
      const text = action === "format" ? draft : bom + (content.includes("\r\n") ? draft.replace(/\n/g, "\r\n") : draft);
      const blob = new Blob([text]);
      if (blob.size > TEXT_PREVIEW_MAX_BYTES) throw new Error(t("files.editTooLarge"));
      const form = new FormData();
      form.set("draft", blob); form.set("version", version);
      const res = await fetch(url + "?type=" + action, { method: "POST", body: form, signal: controller.signal });
      if (!res.ok) throw new Error(t(res.status === 409 ? "files.editConflict" : res.status === 413 ? "files.editTooLarge" : action === "format" ? "files.formatError" : "files.saveError"));
      if (action === "format") setDraft((await res.json()).content);
      else onClose(true);
    } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)); }
    finally { active.current = null; if (!controller.signal.aborted) setBusy(false); }
  }
  function insert(prefix: string, suffix = "", line = false) {
    const el = input.current;
    if (!el) return;
    const start = line ? draft.slice(0, el.selectionStart).lastIndexOf("\n") + 1 : el.selectionStart;
    const end = el.selectionEnd;
    const selection = draft.slice(start, end);
    setDraft(draft.slice(0, start) + prefix + selection + suffix + draft.slice(end));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + prefix.length, end + prefix.length); });
  }
  return <section className="text-file-editor">
    <div className="text-file-editor-tools">
      <span title={path}>{path}{dirty ? " *" : ""}</span>
      {language === "markdown" && <>
        <button disabled={busy} title={t("files.heading")} onClick={() => insert("## ", "", true)}>H2</button>
        <button disabled={busy} title={t("files.bold")} onClick={() => insert("**", "**")}><b>B</b></button>
        <button disabled={busy} title={t("files.italic")} onClick={() => insert("*", "*")}><i>I</i></button>
        <button disabled={busy} title={t("files.list")} onClick={() => insert("- ", "", true)}>•</button>
        <button disabled={busy} title={t("files.inlineCode")} onClick={() => insert("`", "`")}>{"</>"}</button>
      </>}
      {/\.(?:[mc]?js|jsx|tsx?|json)$/i.test(path) && <button disabled={busy} onClick={() => void submit("format")}>{t("files.format")}</button>}
      <button disabled={busy || !dirty} onClick={() => void submit("edit")}>{t("i18n.save")}</button>
      <button disabled={busy} onClick={() => { if (!dirty || window.confirm(t("files.discardDraft"))) onClose(false); }}>{t("i18n.cancel")}</button>
      {busy && <span className="file-preview-spinner" role="status" aria-label={t("i18n.loading")} />}
    </div>
    {error && <div role="alert">{error}</div>}
    <textarea ref={input} autoFocus aria-label={path} spellCheck={false} readOnly={busy} value={draft}
      onChange={e => setDraft(e.target.value)} onKeyDown={e => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (dirty) void submit("edit"); }
        if (!busy && e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); insert("  "); }
      }} />
  </section>;
}
