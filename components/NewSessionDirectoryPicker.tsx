"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { DEFAULT_NEW_SESSION_CWD, getRecentProjects, newProjectParent, projectDisplayName } from "@/lib/session-projects";
import type { SessionInfo } from "@/lib/types";
import { DirectoryPicker } from "./DirectoryPicker";
import { FolderPickerModal } from "./FolderPickerModal";

interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

interface WorktreeInfo {
  projectRoot: string;
  /** Only git checkouts at a top level can switch/create worktrees; repo
   *  subdirectories keep their own project identity. */
  manageable: boolean;
  worktrees: WorktreeEntry[];
}

interface Props {
  /** Directory the new session will start in. */
  cwd: string;
  /** Receives a validated directory. The caller restarts the empty chat there. */
  onChange: (cwd: string) => void;
}

const POPOVER_WIDTH = 380;
const PROJECT_FILTER_THRESHOLD = 6;

function displayPath(path: string, homeDir: string): string {
  return homeDir && (path === homeDir || path.startsWith(`${homeDir}/`)) ? `~${path.slice(homeDir.length)}` : path;
}

/** Left-ellipsized path that keeps its trailing segments visible. */
function PathText({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, direction: "rtl", textAlign: "left", ...style }}>
      <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
    </span>
  );
}

function FolderIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function CheckSlot({ checked }: { checked: boolean }) {
  return checked ? (
    <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <polyline points="1.5 5 4 7.5 8.5 2.5" />
    </svg>
  ) : <span style={{ width: 11, flexShrink: 0 }} />;
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: "8px 12px 4px", fontSize: 10.5, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-dim)" }}>
      {children}
    </div>
  );
}

function OptionButton({ selected = false, disabled, onClick, title, children }: {
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className="new-session-dir-option"
      disabled={disabled}
      onClick={onClick}
      title={title}
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        minHeight: 32,
        padding: "6px 12px",
        border: "none",
        background: "none",
        color: selected ? "var(--text)" : "var(--text-muted)",
        cursor: disabled ? "default" : "pointer",
        textAlign: "left",
        fontSize: 12,
      }}
    >
      {children}
    </button>
  );
}

export function NewSessionDirectoryPicker({ cwd, onChange }: Props) {
  const { t } = useI18n();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const worktreeInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const [homeDir, setHomeDir] = useState("");
  const [projects, setProjects] = useState<string[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [pathPickerOpen, setPathPickerOpen] = useState(false);
  const [worktreeInfo, setWorktreeInfo] = useState<WorktreeInfo | null>(null);
  const [worktreeRefreshKey, setWorktreeRefreshKey] = useState(0);
  const [newWorktreeOpen, setNewWorktreeOpen] = useState(false);
  const [newWorktreeBranch, setNewWorktreeBranch] = useState("");
  const [confirmRemovePath, setConfirmRemovePath] = useState<string | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");

  const isDefault = cwd === DEFAULT_NEW_SESSION_CWD;

  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  // Worktrees of the current directory: shown in the chip and the popover.
  useEffect(() => {
    if (isDefault) {
      setWorktreeInfo(null);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/worktrees?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((data: { projectRoot?: string; isGit?: boolean; isTopLevel?: boolean; worktrees?: WorktreeEntry[] } | null) => {
        if (controller.signal.aborted) return;
        if (!data?.projectRoot || !data.isGit) {
          setWorktreeInfo(null);
          return;
        }
        setWorktreeInfo({
          projectRoot: data.projectRoot,
          manageable: data.isTopLevel === true,
          worktrees: data.worktrees ?? [],
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setWorktreeInfo(null);
      });
    return () => controller.abort();
  }, [cwd, isDefault, worktreeRefreshKey]);

  // Recent projects are loaded the first time the menu opens.
  useEffect(() => {
    if (!open || projects !== null) return;
    const controller = new AbortController();
    setProjectsError(null);
    void fetch("/api/sessions", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as { sessions?: SessionInfo[] };
        if (!controller.signal.aborted) setProjects(getRecentProjects(data.sessions ?? []));
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setProjects([]);
        setProjectsError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, [open, projects]);

  // Home directory, for "~" in the chip and menu paths.
  useEffect(() => {
    if (homeDir) return;
    const controller = new AbortController();
    void fetch("/api/home", { signal: controller.signal })
      .then((response) => response.json())
      .then((data: { home?: string }) => {
        if (!controller.signal.aborted && data.home) setHomeDir(data.home);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [homeDir]);

  const closeMenu = useCallback(() => {
    setOpen(false);
    setFilter("");
    setNewWorktreeOpen(false);
    setNewWorktreeBranch("");
    setConfirmRemovePath(null);
    setNewProjectOpen(false);
    setNewProjectName("");
  }, []);

  const updatePosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(POPOVER_WIDTH, window.innerWidth - 16);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const spaceBelow = window.innerHeight - rect.bottom - 12;
    const spaceAbove = rect.top - 12;
    if (spaceBelow >= 280 || spaceBelow >= spaceAbove) {
      setPosition({ left, width, top: rect.bottom + 6, maxHeight: Math.max(160, spaceBelow - 6) });
    } else {
      setPosition({ left, width, bottom: window.innerHeight - rect.top + 6, maxHeight: Math.max(160, spaceAbove - 6) });
    }
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      closeMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Inline inputs consume Escape to close themselves, not the whole menu.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      closeMenu();
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, closeMenu]);

  /** Validate (and register for file access) a directory, then hand it to the chat. */
  const choose = useCallback(async (candidate: string, source: "menu" | "folder" | "path" = "menu") => {
    const path = candidate.trim();
    if (!path || busy) return;
    if (path === cwd) {
      closeMenu();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
      if (!response.ok || data.error || !data.cwd) throw new Error(data.error ?? `HTTP ${response.status}`);
      closeMenu();
      setPathPickerOpen(false);
      setFolderModalOpen(false);
      onChange(data.cwd);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      // The folder browser has no error slot; reopen the menu so the error is visible.
      if (source === "folder") {
        setFolderModalOpen(false);
        setOpen(true);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, closeMenu, cwd, onChange]);

  const createWorktree = useCallback(async () => {
    const branch = newWorktreeBranch.trim();
    if (!branch || busy || !worktreeInfo) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeInfo.projectRoot, branch }),
      });
      const data = await response.json().catch(() => ({})) as { path?: string; error?: string };
      if (!response.ok || data.error || !data.path) throw new Error(data.error ?? `HTTP ${response.status}`);
      closeMenu();
      onChange(data.path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [busy, closeMenu, newWorktreeBranch, onChange, worktreeInfo]);

  const removeWorktree = useCallback(async (path: string, force: boolean) => {
    if (busy || !worktreeInfo) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/worktrees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeInfo.projectRoot, path, force }),
      });
      const data = await response.json().catch(() => ({})) as { error?: string; dirty?: boolean };
      if (!response.ok) {
        // A dirty checkout needs an explicit force confirmation.
        if (data.dirty && !force) {
          setConfirmRemovePath(path);
          return;
        }
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      setConfirmRemovePath(null);
      if (path === cwd) {
        closeMenu();
        onChange(worktreeInfo.projectRoot);
      } else {
        setWorktreeRefreshKey((key) => key + 1);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [busy, closeMenu, cwd, onChange, worktreeInfo]);

  const currentWorktree = worktreeInfo?.worktrees.find((worktree) => worktree.path === cwd) ?? null;
  const name = projectDisplayName(cwd);
  const query = filter.trim().toLowerCase();
  const recentProjects = (projects ?? []).filter((project) => project !== DEFAULT_NEW_SESSION_CWD);
  // New projects go next to the user's existing ones (home when there are none).
  const projectParent = projects === null ? null : newProjectParent(recentProjects, homeDir) || null;
  const projectNameValue = newProjectName.trim();
  const projectSeparator = projectParent && projectParent.includes("\\") && !projectParent.includes("/") ? "\\" : "/";
  const projectTarget = projectParent
    ? `${displayPath(projectParent, homeDir).replace(/[\\/]+$/, "")}${projectSeparator}${projectNameValue}`
    : null;
  const canCreateProject = Boolean(projectParent && projectNameValue) && !busy;

  const createProject = async () => {
    if (!canCreateProject || !projectParent) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/fs/directories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentPath: projectParent, folderName: projectNameValue }),
      });
      const data = await response.json().catch(() => ({})) as { path?: string; error?: string };
      if (!response.ok || data.error || !data.path) throw new Error(data.error ?? `HTTP ${response.status}`);
      closeMenu();
      onChange(data.path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const showFilter = recentProjects.length > PROJECT_FILTER_THRESHOLD;
  const visibleProjects = query
    ? recentProjects.filter((project) => project.toLowerCase().includes(query))
    : recentProjects;
  const showWorktrees = Boolean(worktreeInfo?.manageable);

  const popover = open && position && portalTarget ? createPortal(
    <div
      ref={popoverRef}
      role="listbox"
      aria-label={t("newSession.chooseDirectory")}
      style={{
        position: "fixed",
        zIndex: 300,
        ...position,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        boxShadow: "0 10px 32px rgba(0,0,0,0.16)",
      }}
    >
      {showFilter && (
        <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t("sidebar.filterProjects")}
            autoFocus
            style={{ width: "100%", boxSizing: "border-box", padding: "5px 8px", fontSize: 12, fontFamily: "var(--font-mono)", border: "1px solid var(--border)", borderRadius: 6, outline: "none", background: "var(--bg)", color: "var(--text)" }}
          />
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingBottom: 4 }}>
        <SectionLabel>{t("newSession.defaultDirectory")}</SectionLabel>
        <OptionButton selected={isDefault} disabled={busy} onClick={() => void choose(DEFAULT_NEW_SESSION_CWD)}>
          <CheckSlot checked={isDefault} />
          <FolderIcon size={12} />
          <span style={{ fontFamily: "var(--font-mono)" }}>{DEFAULT_NEW_SESSION_CWD}</span>
          <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--text-dim)" }}>{t("newSession.default")}</span>
        </OptionButton>

        <SectionLabel>{t("newSession.recentProjects")}</SectionLabel>
        {projects === null ? (
          <div style={{ padding: "6px 12px", fontSize: 12, color: "var(--text-dim)" }}>{t("sidebar.loading")}</div>
        ) : visibleProjects.length === 0 ? (
          <div style={{ padding: "6px 12px", fontSize: 12, color: projectsError ? "#ef4444" : "var(--text-dim)" }}>
            {projectsError ?? (query ? t("sidebar.noMatchingProjects") : t("sidebar.noSessions"))}
          </div>
        ) : visibleProjects.map((project) => {
          const selected = project === cwd;
          return (
            <OptionButton key={project} selected={selected} disabled={busy} title={project} onClick={() => void choose(project)}>
              <CheckSlot checked={selected} />
              <FolderIcon size={12} />
              <span style={{ flexShrink: 0, maxWidth: "45%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: selected ? "var(--text)" : "var(--text-muted)", fontWeight: 500 }}>
                {projectDisplayName(project)}
              </span>
              <PathText text={displayPath(project, homeDir)} style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-dim)" }} />
            </OptionButton>
          );
        })}

        {showWorktrees && worktreeInfo && (
          <>
            <SectionLabel>{t("newSession.worktrees")}</SectionLabel>
            {worktreeInfo.worktrees.map((worktree) => {
              const selected = worktree.path === cwd;
              if (confirmRemovePath === worktree.path) {
                return (
                  <div key={worktree.path} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", background: "rgba(239,68,68,0.06)" }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t("sidebar.forceRemoveCheckout")}
                    </span>
                    <button type="button" disabled={busy} onClick={() => void removeWorktree(worktree.path, true)} style={{ padding: "3px 9px", border: "none", borderRadius: 5, background: "#ef4444", color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}>
                      {t("sidebar.force")}
                    </button>
                    <button type="button" onClick={() => setConfirmRemovePath(null)} style={{ padding: "3px 9px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg-hover)", color: "var(--text-muted)", fontSize: 11, cursor: "pointer", flexShrink: 0 }}>
                      {t("sidebar.cancel")}
                    </button>
                  </div>
                );
              }
              return (
                <div key={worktree.path} style={{ display: "flex", alignItems: "center" }}>
                  <OptionButton selected={selected} disabled={busy} title={worktree.path} onClick={() => void choose(worktree.path)}>
                    <CheckSlot checked={selected} />
                    <BranchIcon />
                    <PathText text={worktree.branch ?? displayPath(worktree.path, homeDir)} style={{ flex: 1, fontFamily: "var(--font-mono)" }} />
                    {worktree.isMain && <span style={{ flexShrink: 0, fontSize: 10.5, color: "var(--text-dim)" }}>{t("sidebar.main")}</span>}
                  </OptionButton>
                  {!worktree.isMain && (
                    <button
                      type="button"
                      className="new-session-dir-remove"
                      disabled={busy}
                      onClick={() => void removeWorktree(worktree.path, false)}
                      title={t("sidebar.removeWorktreeTitle", { path: worktree.path })}
                      aria-label={t("sidebar.removeWorktreeTitle", { path: worktree.path })}
                      style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, marginRight: 6, padding: 0, border: "none", borderRadius: 5, background: "none", color: "var(--text-dim)", cursor: "pointer", flexShrink: 0 }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                        <path d="M10 11v6M14 11v6" />
                        <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                      </svg>
                    </button>
                  )}
                </div>
              );
            })}
            {newWorktreeOpen ? (
              <div style={{ display: "flex", gap: 6, padding: "6px 12px" }}>
                <input
                  ref={worktreeInputRef}
                  value={newWorktreeBranch}
                  onChange={(event) => setNewWorktreeBranch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void createWorktree();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setNewWorktreeOpen(false);
                      setNewWorktreeBranch("");
                    }
                  }}
                  placeholder={t("sidebar.branchName")}
                  style={{ flex: 1, minWidth: 0, padding: "4px 8px", fontSize: 12, fontFamily: "var(--font-mono)", border: "1px solid var(--accent)", borderRadius: 5, outline: "none", background: "var(--bg)", color: "var(--text)" }}
                />
                <button
                  type="button"
                  disabled={busy || !newWorktreeBranch.trim()}
                  onClick={() => void createWorktree()}
                  style={{ padding: "4px 10px", border: "none", borderRadius: 5, background: "var(--accent)", color: "#fff", fontSize: 11.5, fontWeight: 600, cursor: busy || !newWorktreeBranch.trim() ? "not-allowed" : "pointer", opacity: busy || !newWorktreeBranch.trim() ? 0.65 : 1, flexShrink: 0 }}
                >
                  {busy ? t("sidebar.creating") : t("sidebar.create")}
                </button>
              </div>
            ) : (
              <OptionButton
                disabled={busy}
                title={t("sidebar.createWorktreeTitle")}
                onClick={() => {
                  setNewWorktreeOpen(true);
                  setTimeout(() => worktreeInputRef.current?.focus(), 0);
                }}
              >
                <span style={{ width: 11, flexShrink: 0 }} />
                <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                  <line x1="5" y1="1" x2="5" y2="9" />
                  <line x1="1" y1="5" x2="9" y2="5" />
                </svg>
                <span>{t("sidebar.newWorktree")}</span>
              </OptionButton>
            )}
          </>
        )}

        <div style={{ height: 1, margin: "6px 0 2px", background: "var(--border)" }} />
        {newProjectOpen ? (
          <div style={{ padding: "6px 12px" }}>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                ref={projectInputRef}
                value={newProjectName}
                onChange={(event) => {
                  setNewProjectName(event.target.value);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void createProject();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setNewProjectOpen(false);
                    setNewProjectName("");
                  }
                }}
                placeholder={t("newSession.projectName")}
                aria-label={t("newSession.projectName")}
                autoComplete="off"
                spellCheck={false}
                style={{ flex: 1, minWidth: 0, padding: "4px 8px", fontSize: 12, fontFamily: "var(--font-mono)", border: "1px solid var(--accent)", borderRadius: 5, outline: "none", background: "var(--bg)", color: "var(--text)" }}
              />
              <button
                type="button"
                disabled={!canCreateProject}
                onClick={() => void createProject()}
                style={{ padding: "4px 10px", border: "none", borderRadius: 5, background: "var(--accent)", color: "#fff", fontSize: 11.5, fontWeight: 600, cursor: canCreateProject ? "pointer" : "not-allowed", opacity: canCreateProject ? 1 : 0.65, flexShrink: 0 }}
              >
                {busy ? t("sidebar.creating") : t("sidebar.create")}
              </button>
            </div>
            {projectTarget ? (
              <PathText
                text={t("newSession.projectLocation", { path: projectTarget })}
                style={{ display: "block", marginTop: 4, fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-dim)" }}
              />
            ) : (
              <div style={{ marginTop: 4, fontSize: 10.5, color: "var(--text-dim)" }}>{t("sidebar.loading")}</div>
            )}
          </div>
        ) : (
          <OptionButton
            disabled={busy}
            onClick={() => {
              setError(null);
              setNewProjectOpen(true);
              setTimeout(() => projectInputRef.current?.focus(), 0);
            }}
          >
            <span style={{ width: 11, flexShrink: 0 }} />
            <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true" style={{ flexShrink: 0 }}>
              <line x1="5" y1="1" x2="5" y2="9" />
              <line x1="1" y1="5" x2="9" y2="5" />
            </svg>
            <span>{t("newSession.newProject")}</span>
          </OptionButton>
        )}
        <OptionButton
          disabled={busy}
          onClick={() => {
            closeMenu();
            setFolderModalOpen(true);
          }}
        >
          <span style={{ width: 11, flexShrink: 0 }} />
          <FolderIcon size={12} />
          <span>{t("newSession.browse")}</span>
        </OptionButton>
        <OptionButton
          disabled={busy}
          onClick={() => {
            closeMenu();
            setError(null);
            setPathPickerOpen(true);
          }}
        >
          <span style={{ width: 11, flexShrink: 0 }} />
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          <span>{t("sidebar.customPath")}</span>
        </OptionButton>
      </div>
      {error && (
        <div role="alert" style={{ flexShrink: 0, padding: "6px 12px 8px", borderTop: "1px solid var(--border)", color: "#dc2626", fontSize: 11.5, lineHeight: 1.4, overflowWrap: "anywhere" }}>
          {error}
        </div>
      )}
    </div>,
    portalTarget,
  ) : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          if (open) {
            closeMenu();
            return;
          }
          setError(null);
          setOpen(true);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`${t("newSession.chooseDirectory")}\n${cwd}`}
        className="new-session-dir-chip"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          maxWidth: "100%",
          height: 30,
          padding: "0 10px",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: open ? "var(--bg-selected)" : "var(--bg-panel)",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          lineHeight: 1.3,
          transition: "background 0.12s, border-color 0.12s",
        }}
      >
        <FolderIcon />
        <span style={{ flexShrink: 0, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontWeight: 600 }}>
          {name}
        </span>
        {name !== cwd && (
          <PathText text={displayPath(cwd, homeDir)} style={{ flex: "0 1 auto", fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-dim)" }} />
        )}
        {currentWorktree && !currentWorktree.isMain && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0, maxWidth: 140, color: "var(--accent)", fontSize: 11 }}>
            <BranchIcon />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{currentWorktree.branch}</span>
          </span>
        )}
        {isDefault && (
          <span style={{ flexShrink: 0, padding: "0 5px", border: "1px solid var(--border)", borderRadius: 4, fontSize: 10, lineHeight: "15px", color: "var(--text-dim)" }}>
            {t("newSession.default")}
          </span>
        )}
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>
      {popover}
      {pathPickerOpen && (
        <DirectoryPicker
          busy={busy}
          error={error}
          onCancel={() => {
            setPathPickerOpen(false);
            setError(null);
          }}
          onSelect={(path) => void choose(path, "path")}
        />
      )}
      <FolderPickerModal
        open={folderModalOpen}
        initialPath={isDefault ? null : cwd}
        onSelect={(path) => void choose(path, "folder")}
        onClose={() => setFolderModalOpen(false)}
      />
    </>
  );
}
