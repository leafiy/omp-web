"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import { encodeFilePathForApi, getFileDirectory, getFileName, joinFilePath } from "@/lib/file-paths";
import { getFileClipboard, getServerFileClipboard, setFileClipboard, subscribeFileClipboard, type FileClipboard } from "@/lib/file-browser-clipboard";
import type { FileOperationRequest, FileOperationResult } from "@/lib/file-operation-types";
import { InlineConfirmation } from "./InlineConfirmation";
import { FileSpinner } from "./FileSpinner";
import styles from "./FileActions.module.css";

export interface FileActionTarget { fullPath: string; isDir: boolean; isRoot?: boolean; }
export interface FileActionsHandle { open: (target: FileActionTarget, point: { x: number; y: number }) => void; }
interface Props {
  cwd: string;
  onUpload: (directory: string) => void;
  onRefresh: () => void;
  onComplete: (result: FileOperationResult) => void;
  onBusyChange: (busy: boolean) => void;
}
interface Menu { target: FileActionTarget; x: number; y: number; version?: string; symlink?: boolean; unavailable?: boolean; }
interface Dialog {
  kind: "rename" | "move" | "delete" | "paste" | "new-file" | "new-directory";
  source?: string;
  version?: string;
  directory: string;
  clipboard?: FileClipboard;
  symlink?: boolean;
}
const directoryOf = (target: FileActionTarget) => target.isDir ? target.fullPath : getFileDirectory(target.fullPath);
const validName = (value: string) => value.length > 0 && value !== "." && value !== ".." && !/[\\/\x00-\x1f\x7f]/.test(value);

export const FileActions = forwardRef<FileActionsHandle, Props>(function FileActions({ cwd, onUpload, onRefresh, onComplete, onBusyChange }, ref) {
  const { t } = useI18n();
  const clipboard = useSyncExternalStore(subscribeFileClipboard, getFileClipboard, getServerFileClipboard);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null), formRef = useRef<HTMLDivElement>(null);
  const metadataRequest = useRef<AbortController | null>(null), busyRef = useRef(false), mounted = useRef(true);
  const focusBeforeMenu = useRef<HTMLElement | null>(null);
  const refreshRef = useRef(onRefresh), completeRef = useRef(onComplete);
  refreshRef.current = onRefresh; completeRef.current = onComplete;
  const closeMenu = useCallback((restoreFocus = true) => {
    metadataRequest.current?.abort(); setMenu(null);
    if (restoreFocus && focusBeforeMenu.current?.isConnected) focusBeforeMenu.current.focus();
  }, []);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; metadataRequest.current?.abort(); }; }, []);
  useEffect(() => { closeMenu(false); setDialog(null); }, [cwd, closeMenu]);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  useImperativeHandle(ref, () => ({ open(target, point) {
    if (busyRef.current) return;
    metadataRequest.current?.abort();
    const controller = new AbortController(); metadataRequest.current = controller;
    focusBeforeMenu.current = document.activeElement as HTMLElement | null;
    const next: Menu = { target, ...point };
    setMenu(next); setDialog(null);
    if (!target.isRoot) {
      void fetch(`/api/files/${encodeFilePathForApi(target.fullPath)}?type=entry`, { signal: controller.signal, cache: "no-store" })
        .then(async response => { if (!response.ok) throw new Error(); return response.json() as Promise<{ version: string; isSymlink: boolean }>; })
        .then(entry => { if (!controller.signal.aborted) setMenu(current => current === next ? { ...next, version: entry.version, symlink: entry.isSymlink } : current); })
        .catch(() => { if (!controller.signal.aborted) setMenu(current => current === next ? { ...next, unavailable: true } : current); });
    }
  } }), []);

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const element = menuRef.current, rect = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))}px`;
    if (!element.contains(document.activeElement)) element.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) closeMenu(false); };
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) closeMenu(false); };
    document.addEventListener("pointerdown", outside, true); document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", scroll);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("scroll", scroll, true); window.removeEventListener("resize", scroll); };
  }, [menu, closeMenu]);
  useLayoutEffect(() => { if (dialog && dialog.kind !== "delete") formRef.current?.querySelector<HTMLInputElement>("input")?.focus(); }, [dialog]);

  const execute = async (request: FileOperationRequest, consumedClipboard?: FileClipboard) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setDialog(null); setNotice(null); closeMenu(false);
    try {
      const response = await fetch("/api/file-operations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
      const data = await response.json() as FileOperationResult & { error?: string; partial?: boolean };
      if (!response.ok) {
        const known = ["invalid", "denied", "protected", "conflict", "changed", "not-found", "unsupported", "too-large", "busy", "failed"];
        const text = t(`files.error.${known.includes(data.error ?? "") ? data.error : "failed"}`) + (data.partial ? `\n${t("files.partialOperation")}` : "");
        if (mounted.current) setNotice({ error: true, text });
        return;
      }
      if (consumedClipboard?.kind === "move" && getFileClipboard() === consumedClipboard) setFileClipboard(null);
      if (mounted.current) {
        completeRef.current(data);
        setNotice({ error: false, text: t("files.operationDone", { path: request.destination ?? request.source ?? "" }) });
      }
    } catch {
      if (mounted.current) setNotice({ error: true, text: t("files.operationUnknown") });
    } finally {
      busyRef.current = false;
      if (mounted.current) { setBusy(false); refreshRef.current(); }
    }
  };
  const openDialog = (next: Dialog, input = "") => { closeMenu(false); setDialog(next); setValue(input); setNotice(null); };
  const submit = () => {
    if (!dialog) return;
    const source = dialog.source, sourceVersion = dialog.version;
    if (dialog.kind === "move") {
      const directory = value.startsWith("/") ? value : joinFilePath(cwd, value);
      void execute({ operation: "move", source, sourceVersion, destination: joinFilePath(directory, getFileName(source!)), confirm: true });
    } else if (dialog.kind === "rename") void execute({ operation: "move", source, sourceVersion, destination: joinFilePath(dialog.directory, value), confirm: true });
    else if (dialog.kind === "paste") void execute({ operation: dialog.clipboard!.kind, source: dialog.clipboard!.source, sourceVersion: dialog.clipboard!.sourceVersion, destination: joinFilePath(dialog.directory, value), confirm: true }, dialog.clipboard);
    else if (dialog.kind === "new-file" || dialog.kind === "new-directory") void execute({ operation: dialog.kind, destination: joinFilePath(dialog.directory, value) });
  };
  const label = dialog ? t(`files.action.${dialog.kind}`) : "";
  const ready = Boolean(menu?.version && !menu.unavailable && !menu.target.isRoot);
  const menuDirectory = menu ? directoryOf(menu.target) : cwd;
  const saveClipboard = (kind: FileClipboard["kind"]) => {
    if (!ready || !menu?.version) return;
    setFileClipboard({ kind, source: menu.target.fullPath, sourceVersion: menu.version });
    setNotice(null); closeMenu();
  };
  return <>
    {clipboard && <div className={styles.panel} data-file-clipboard>
      <div>{t(clipboard.kind === "copy" ? "files.clipboardCopy" : "files.clipboardMove", { path: clipboard.source })}</div>
      <div className={styles.buttons}><button type="button" disabled={busy} onClick={() => setFileClipboard(null)}>{t("files.clearClipboard")}</button></div>
    </div>}
    {busy && <div role="status" className={`${styles.panel} ${styles.status}`}><FileSpinner />{t("files.operationBusy")}</div>}
    {notice && <div role={notice.error ? "alert" : "status"} className={styles.panel} style={{ color: notice.error ? "#f87171" : "var(--text-muted)", whiteSpace: "pre-wrap" }}>
      {notice.text}<div className={styles.buttons}><button type="button" onClick={() => setNotice(null)}>{t("files.dismissError")}</button></div>
    </div>}
    {dialog?.kind === "delete" && <div style={{ padding: "0 8px" }}><InlineConfirmation key={dialog.source} title={t("files.action.delete")}
      message={t(dialog.symlink ? "files.deleteLinkWarning" : "files.deleteWarning", { path: dialog.source! })} confirmLabel={t("files.action.delete")} cancelLabel={t("files.cancel")}
      onCancel={() => setDialog(null)} onConfirm={() => void execute({ operation: "delete", source: dialog.source, sourceVersion: dialog.version, confirm: true })} /></div>}
    {dialog && dialog.kind !== "delete" && <div ref={formRef} className={styles.panel} role="group" aria-label={label} data-file-operation-form
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDialog(null); } }}>
      <form onSubmit={event => { event.preventDefault(); if (dialog.kind === "move" ? value.trim() : validName(value)) submit(); }}>
        <strong>{label}</strong><p>{dialog.source ?? dialog.clipboard?.source}</p>
        <p>{t("files.targetDirectory", { path: dialog.kind === "move" ? value.startsWith("/") ? value : joinFilePath(cwd, value) : dialog.directory })}</p>
        <label>{t(dialog.kind === "move" ? "files.destinationDirectory" : "files.entryName")}<input value={value} onChange={event => setValue(event.target.value)} autoComplete="off" spellCheck={false} required /></label>
        {dialog.kind === "move" && <p>{t("files.moveHint")}</p>}
        <div className={styles.buttons}><button type="button" onClick={() => setDialog(null)}>{t("files.cancel")}</button><button type="submit" disabled={busy || !(dialog.kind === "move" ? value.trim() : validName(value))}>{label}</button></div>
      </form>
    </div>}
    {menu && createPortal(<div ref={menuRef} className={styles.menu} style={{ left: menu.x, top: menu.y }} role="menu" aria-label={t("files.menu")}
      onContextMenu={event => event.preventDefault()}
      onKeyDown={event => {
        if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.preventDefault(); event.stopPropagation(); closeMenu(); return; }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault(); event.stopPropagation(); const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
          const index = items.indexOf(document.activeElement as HTMLElement), next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; items[next]?.focus();
        }
      }}>
      <div className={styles.menuTitle}>{menu.target.fullPath}</div>
      {menu.symlink && <div className={styles.menuTitle}>{t("files.symbolicLinkHint")}</div>}
      {!menu.target.isRoot && !menu.version && !menu.unavailable && <div role="status" className={`${styles.menuTitle} ${styles.status}`}><FileSpinner size={12} />{t("files.checking")}</div>}
      <button type="button" role="menuitem" disabled={!ready} onClick={() => saveClipboard("copy")}>{t("files.action.copy")}</button>
      <button type="button" role="menuitem" disabled={!ready} onClick={() => saveClipboard("move")}>{t("files.action.cut")}</button>
      <button type="button" role="menuitem" disabled={!clipboard} onClick={() => clipboard && openDialog({ kind: "paste", directory: menuDirectory, clipboard }, getFileName(clipboard.source))}>{t("files.action.paste")}</button>
      <button type="button" role="menuitem" disabled={!ready} onClick={() => openDialog({ kind: "move", source: menu.target.fullPath, version: menu.version, directory: getFileDirectory(menu.target.fullPath) }, getFileDirectory(menu.target.fullPath))}>{t("files.action.move")}</button>
      <button type="button" role="menuitem" disabled={!ready} onClick={() => openDialog({ kind: "rename", source: menu.target.fullPath, version: menu.version, directory: getFileDirectory(menu.target.fullPath) }, getFileName(menu.target.fullPath))}>{t("files.action.rename")}</button>
      <button type="button" role="menuitem" onClick={() => openDialog({ kind: "new-file", directory: menuDirectory })}>{t("files.action.new-file")}</button>
      <button type="button" role="menuitem" onClick={() => openDialog({ kind: "new-directory", directory: menuDirectory })}>{t("files.action.new-directory")}</button>
      <button type="button" role="menuitem" onClick={() => { onUpload(menuDirectory); closeMenu(); }}>{t("files.action.upload")}</button>
      <button type="button" role="menuitem" onClick={() => { const p = menu.target.fullPath; closeMenu(); void copyText(p).then(() => mounted.current && setNotice({ error: false, text: t("files.pathCopied") })).catch(() => mounted.current && setNotice({ error: true, text: t("files.copyPathFailed") })); }}>{t("files.action.copy-path")}</button>
      {!menu.target.isDir && <a role="menuitem" href={`/api/files/${encodeFilePathForApi(menu.target.fullPath)}?type=download`} download onClick={() => closeMenu()}>{t("files.download")}</a>}
      <button type="button" role="menuitem" disabled={!ready} className={styles.danger} onClick={() => openDialog({ kind: "delete", source: menu.target.fullPath, version: menu.version, directory: menuDirectory, symlink: menu.symlink })}>{t("files.action.delete")}</button>
      {menu.unavailable && <div className={styles.menuTitle}>{t("files.entryUnavailable")}</div>}
    </div>, document.body)}
  </>;
});
