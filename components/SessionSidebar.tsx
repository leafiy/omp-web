"use client";

import { historyClientCache } from "@/lib/history-client-cache";

import { useEffect, useState, useCallback, useRef, type CSSProperties, type ReactNode } from "react";
import type { SessionInfo } from "@/lib/types";
import { engineForSession, engineLabel, supportsSessionDeletion } from "@/lib/engine";
import {
  DEFAULT_NEW_SESSION_CWD,
  groupSessionsByProject,
  projectDisplayName,
  projectParentPath,
  sessionProjectRoot,
} from "@/lib/session-projects";
import { useI18n } from "@/hooks/useI18n";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { FileSpinner } from "./FileSpinner";
import { StarfieldEmblem } from "./StarfieldEmblem";
import { useTheme } from "@/hooks/useTheme";

function ToolbarIconButton({
  onClick,
  title,
  disabled,
  skipHover,
  color,
  background = "none",
  marginRight,
  ariaPressed,
  children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  skipHover?: boolean;
  color: string;
  background?: string;
  marginRight?: number;
  ariaPressed?: boolean;
  children: ReactNode;
}) {
  const enter = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || skipHover) return;
    e.currentTarget.style.color = "var(--text-muted)";
    e.currentTarget.style.background = "var(--bg-hover)";
  };
  const leave = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || skipHover) return;
    e.currentTarget.style.color = color;
    e.currentTarget.style.background = background;
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={ariaPressed}
      style={{
        position: "relative",
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 26, height: 26, padding: 0, marginRight,
        background,
        border: "none",
        color,
        cursor: disabled ? "default" : "pointer",
        borderRadius: 5,
        flexShrink: 0,
        opacity: disabled ? 0.6 : 1,
        transition: "color 0.3s, background 0.3s",
      }}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      {children}
    </button>
  );
}

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  /** Starts an empty chat; its directory can still be changed in the chat. */
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  /** Working directory of the open chat (selected session or new-session draft). */
  activeCwd?: string | null;
  onOpenFile?: (filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff" }) => void;
  explorerRefreshKey?: number;
  onExplorerRefresh?: () => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
}

const UNREAD_SESSIONS_STORAGE_KEY = "omp-web:unread-session-ids";
const PROJECT_EXPANSION_STORAGE_KEY = "omp-web:sidebar-project-expansion";
const RUNNING_SESSIONS_POLL_MS = 2500;
/** Projects expanded until the user toggles them (most recent first). */
const DEFAULT_EXPANDED_PROJECTS = 5;
/** Top-level sessions shown per project before "Show more". */
const PROJECT_SESSION_PREVIEW = 5;

function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

/** Explicit expand/collapse choices keyed by project root. */
function loadProjectExpansion(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PROJECT_EXPANSION_STORAGE_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
    );
  } catch {
    return {};
  }
}

function saveProjectExpansion(state: Record<string, boolean>): void {
  if (typeof window === "undefined") return;
  try {
    if (Object.keys(state).length === 0) window.localStorage.removeItem(PROJECT_EXPANSION_STORAGE_KEY);
    else window.localStorage.setItem(PROJECT_EXPANSION_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

/** Compact age for list rows: "now", "5m", "3h", "2d", "4w", then a date. */
function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  if (!Number.isFinite(diff)) return "";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 35) return `${Math.floor(days / 7)}w`;
  return date.getFullYear() === now.getFullYear()
    ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short" });
}

/** Substitute the home dir prefix with ~ (no path truncation — see PathLabel) */
function displayCwd(cwd: string, homeDir?: string): string {
  return (homeDir && (cwd === homeDir || cwd.startsWith(`${homeDir}/`))) ? "~" + cwd.slice(homeDir.length) : cwd;
}

/**
 * Path label that ellipsizes on the LEFT, keeping the (most relevant) trailing
 * segments visible: "…orkspace/pi-web". Shows as much of the path as fits
 * instead of a fixed number of segments. The rtl container moves the ellipsis
 * to the left edge; the inner plaintext bidi isolation keeps the path itself
 * rendered strictly left-to-right (no punctuation reordering).
 */
function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
        minWidth: 0,
        lineHeight: 1.35,
        direction: "rtl",
        textAlign: "left",
        ...style,
      }}
    >
      <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
    </span>
  );
}

interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
  const byId = new Map<string, SessionTreeNode>();
  for (const s of sessions) {
    byId.set(s.id, { session: s, children: [] });
  }

  // Build a map of parentSessionId chains so we can resolve missing ancestors
  const parentOf = new Map<string, string>();
  for (const s of sessions) {
    if (s.parentSessionId) parentOf.set(s.id, s.parentSessionId);
  }

  // Walk up the parentSessionId chain to find the nearest ancestor that exists in byId
  function resolveAncestor(id: string): string | null {
    let cur = parentOf.get(id);
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) return null; // cycle guard
      visited.add(cur);
      if (byId.has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return null;
  }

  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.id);
    if (ancestor) {
      byId.get(ancestor)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort each level by modified desc
  const sort = (nodes: SessionTreeNode[]) => {
    nodes.sort((a, b) => b.session.modified.localeCompare(a.session.modified));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";

function useScramble(target: string, running: boolean): string {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<number | null>(null);
  const iterRef = useRef(0);

  useEffect(() => {
    if (!running) {
      setDisplay(target);
      return;
    }
    iterRef.current = 0;
    const totalFrames = target.length * 4;

    const step = () => {
      iterRef.current += 1;
      const progress = iterRef.current / totalFrames;
      const resolved = Math.floor(progress * target.length);

      setDisplay(
        target
          .split("")
          .map((char, i) => {
            if (char === " ") return " ";
            if (i < resolved) return char;
            return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
          })
          .join("")
      );

      if (iterRef.current < totalFrames) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        setDisplay(target);
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [target, running]);

  return display;
}

function PiWebTitle() {
  const [showVersion, setShowVersion] = useState(false);
  const [scrambling, setScrambling] = useState(false);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const target = showVersion ? `Web ${process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"} · OMP / Pi RPC` : "OMP Web";
  const display = useScramble(target, scrambling);

  const triggerScramble = useCallback((toVersion: boolean) => {
    setShowVersion(toVersion);
    setScrambling(true);
    setTimeout(() => setScrambling(false), (toVersion ? 6 : 8) * 4 * (1000 / 60) + 100);
  }, []);

  const handleClick = useCallback(() => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);

    const next = !showVersion;
    triggerScramble(next);

    if (next) {
      revertTimerRef.current = setTimeout(() => triggerScramble(false), 3000);
    }
  }, [showVersion, triggerScramble]);

  useEffect(() => () => { if (revertTimerRef.current) clearTimeout(revertTimerRef.current); }, []);

  const { isStarfield } = useTheme();

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
      {isStarfield && <StarfieldEmblem size={20} />}
      <button
        onClick={handleClick}
        style={{
          background: "none", border: "none", padding: 0, cursor: "default",
          fontWeight: 800, fontSize: isStarfield ? 14 : 15,
          letterSpacing: isStarfield ? "0.12em" : "-0.01em",
          color: showVersion ? "var(--accent)" : "var(--text)",
          fontFamily: isStarfield ? "var(--font-display, 'Orbitron', sans-serif)" : "var(--font-mono)",
          minWidth: "6ch",
          textTransform: isStarfield ? "uppercase" : "none",
        }}
      >
        {display}
      </button>
    </div>
  );
}

function treeContains(node: SessionTreeNode, sessionId: string | null): boolean {
  if (!sessionId) return false;
  return node.session.id === sessionId || node.children.some((child) => treeContains(child, sessionId));
}

function newClientSessionId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, initialSessionId, onInitialRestoreDone, refreshKey, onSessionDeleted, activeCwd, onOpenFile, explorerRefreshKey, onExplorerRefresh, onAtMention, onAtMentions }: Props) {
  const { t } = useI18n();
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [homeDir, setHomeDir] = useState<string>("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [projectExpansion, setProjectExpansion] = useState<Record<string, boolean>>(() => loadProjectExpansion());
  const [expandedSessionLists, setExpandedSessionLists] = useState<Set<string>>(() => new Set());
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerKey, setExplorerKey] = useState(0);
  const [explorerUploadBusy, setExplorerUploadBusy] = useState(false);
  const [changesCount, setChangesCount] = useState(0);
  const [changesCollapsed, setChangesCollapsed] = useState(true);
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [explorerRefreshDone, setExplorerRefreshDone] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  // Once polling has delivered a snapshot it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const runningPollAuthoritativeRef = useRef(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const explorerRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileExplorerRef = useRef<FileExplorerHandle>(null);
  const sessionListRequestRef = useRef(0);

  const loadSessions = useCallback(async (showLoading = false) => {
    const request = ++sessionListRequestRef.current;
    try {
      if (showLoading) setLoading(true);
      const res = await fetch("/api/sessions");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { sessions: SessionInfo[]; runningSessionIds?: string[] };
      if (request !== sessionListRequestRef.current) return;
      setAllSessions(data.sessions);
      // Treat the fetched running set as an initial fallback only. Once the
      // lightweight poll is live, a slow session-list fetch cannot overwrite it.
      if (!runningPollAuthoritativeRef.current) {
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      }
      // Drop unread markers for sessions that no longer exist (e.g. deleted).
      const existingIds = new Set(data.sessions.map((s) => s.id));
      setUnreadSessionIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set([...prev].filter((id) => existingIds.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setError(null);
      if (!showLoading) {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
      }
    } catch (e) {
      if (request === sessionListRequestRef.current) setError(String(e));
    } finally {
      if (request === sessionListRequestRef.current) {
        setLoading(false);
        setSessionsLoaded(true);
      }
    }
  }, []);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst);
  }, [loadSessions, refreshKey]);

  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);

  useEffect(() => {
    saveProjectExpansion(projectExpansion);
  }, [projectExpansion]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const schedule = () => {
      clearTimer();
      if (stopped || document.visibilityState !== "visible") return;
      timer = setTimeout(() => void poll(), RUNNING_SESSIONS_POLL_MS);
    };

    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const current = new AbortController();
      controller?.abort();
      controller = current;
      try {
        const res = await fetch("/api/agent/running", {
          cache: "no-store",
          signal: current.signal,
        });
        if (!res.ok) return;
        const data = await res.json() as { runningSessionIds?: string[] };
        if (stopped || controller !== current) return;
        runningPollAuthoritativeRef.current = true;
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      } catch {
        // Keep the last known state; the next visible-tab poll retries.
      } finally {
        if (controller === current) controller = null;
        schedule();
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void poll();
        return;
      }
      clearTimer();
      controller?.abort();
      controller = null;
    };

    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completedInBackground = [...previous].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId);
    const newlyRunning = [...runningSessionIds];

    if (completedInBackground.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        newlyRunning.forEach((id) => next.delete(id));
        completedInBackground.forEach((id) => next.add(id));
        return next;
      });
    }
    if (completedInBackground.length > 0) {
      loadSessions(false);
    }

    previousRunningSessionIdsRef.current = runningSessionIds;
  }, [runningSessionIds, selectedSessionId, loadSessions]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);

  useEffect(() => {
    if (explorerRefreshKey !== undefined) setExplorerKey((k) => k + 1);
  }, [explorerRefreshKey]);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string }) => {
      if (d.home) setHomeDir(d.home);
    }).catch(() => {});
  }, []);

  // Restore the ?session= URL target once the first session list is known
  // (also when the list is empty or failed, so the shell never waits forever).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!sessionsLoaded || restoredRef.current) return;
    restoredRef.current = true;
    if (!initialSessionId) return;
    const target = allSessions.find((s) => s.id === initialSessionId);
    if (target) onSelectSession(target, true);
    else onInitialRestoreDone?.();
  }, [sessionsLoaded, allSessions, initialSessionId, onSelectSession, onInitialRestoreDone]);

  const startNewSession = useCallback((cwd: string) => {
    // A client-side placeholder ID: the engine is spawned lazily on first use.
    onNewSession?.(newClientSessionId(), cwd);
  }, [onNewSession]);

  const groups = groupSessionsByProject(allSessions);
  const groupIndex = new Map(groups.map((group, index) => [group.root, index]));
  const query = filter.trim().toLowerCase();
  const visibleGroups = query
    ? groups.flatMap((group) => {
        if (group.root.toLowerCase().includes(query)) return [group];
        const sessions = group.sessions.filter((s) =>
          (s.name ?? "").toLowerCase().includes(query) || (s.firstMessage ?? "").toLowerCase().includes(query));
        return sessions.length > 0 ? [{ ...group, sessions }] : [];
      })
    : groups;

  // The project that owns the open session (transient sessions resolve by cwd).
  const selectedSessionInfo = selectedSessionId ? allSessions.find((s) => s.id === selectedSessionId) : undefined;
  const activeProjectRoot = selectedSessionInfo
    ? sessionProjectRoot(selectedSessionInfo)
    : selectedSessionId && activeCwd
      ? (allSessions.find((s) => s.cwd === activeCwd)?.projectRoot || activeCwd)
      : null;
  const newSessionActive = !selectedSessionId && Boolean(activeCwd);

  const nameCounts = new Map<string, number>();
  for (const group of groups) {
    const name = projectDisplayName(group.root);
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }

  const toggleProject = (root: string, expanded: boolean) => {
    const knownRoots = new Set(groups.map((group) => group.root));
    setProjectExpansion((prev) => {
      // Drop choices for projects that no longer have sessions.
      const next: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(prev)) {
        if (knownRoots.has(key)) next[key] = value;
      }
      next[root] = !expanded;
      return next;
    });
  };

  const toggleSessionList = (root: string) => {
    setExpandedSessionLists((prev) => {
      const next = new Set(prev);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });
  };

  const closeFilter = () => {
    setFilterOpen(false);
    setFilter("");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ padding: "12px 10px 8px", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <PiWebTitle />
          <button
            onClick={() => loadSessions(false)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              background: sessionRefreshDone ? "rgba(74,222,128,0.18)" : "var(--bg-hover)",
              border: `1px solid ${sessionRefreshDone ? "rgba(74,222,128,0.4)" : "var(--border)"}`,
              color: sessionRefreshDone ? "#4ade80" : "var(--text-muted)",
              cursor: "pointer",
              width: 32, height: 32,
              borderRadius: 7,
              padding: 0,
              flexShrink: 0,
              transition: "background 0.3s, color 0.3s, border-color 0.3s",
            }}
            onMouseEnter={(e) => {
              if (sessionRefreshDone) return;
              e.currentTarget.style.background = "var(--bg-selected)";
              e.currentTarget.style.color = "var(--accent)";
              e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
            }}
            onMouseLeave={(e) => {
              if (sessionRefreshDone) return;
              e.currentTarget.style.background = "var(--bg-hover)";
              e.currentTarget.style.color = "var(--text-muted)";
              e.currentTarget.style.borderColor = "var(--border)";
            }}
            title={t("sidebar.refresh")}
            aria-label={t("sidebar.refresh")}
          >
            {sessionRefreshDone ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            )}
          </button>
        </div>

        {/* New session: the directory is chosen in the chat (defaults to /tmp). */}
        <button
          type="button"
          className="sidebar-new-session"
          onClick={() => startNewSession(DEFAULT_NEW_SESSION_CWD)}
          disabled={!onNewSession}
          aria-current={newSessionActive ? "page" : undefined}
          title={t("sidebar.newSessionDefaultTitle", { path: DEFAULT_NEW_SESSION_CWD })}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            gap: 8,
            height: 34,
            padding: "0 10px",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: newSessionActive ? "var(--bg-selected)" : "var(--bg-hover)",
            color: newSessionActive ? "var(--text)" : "var(--text-muted)",
            cursor: onNewSession ? "pointer" : "not-allowed",
            fontSize: 12.5,
            fontWeight: 500,
            textAlign: "left",
            transition: "background 0.12s, color 0.12s, border-color 0.12s",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
          <span style={{ flex: 1, minWidth: 0 }}>{t("sidebar.newSession")}</span>
        </button>
      </div>

      {/* Projects heading + filter */}
      <div style={{ display: "flex", alignItems: "center", height: 28, padding: "0 8px 0 16px", flexShrink: 0 }}>
        <span style={{ flex: 1, fontSize: 11, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-dim)" }}>
          {t("sidebar.projects")}
        </span>
        <ToolbarIconButton
          onClick={() => (filterOpen ? closeFilter() : setFilterOpen(true))}
          title={t("sidebar.toggleFilter")}
          ariaPressed={filterOpen}
          color={filterOpen ? "var(--accent)" : "var(--text-dim)"}
          background={filterOpen ? "var(--bg-selected)" : "none"}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
        </ToolbarIconButton>
      </div>
      {filterOpen && (
        <div style={{ padding: "0 10px 6px", flexShrink: 0 }}>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeFilter();
            }}
            placeholder={t("sidebar.filterSessions")}
            autoFocus
            style={{
              width: "100%",
              fontSize: 12,
              padding: "5px 8px",
              border: "1px solid var(--border)",
              borderRadius: 6,
              outline: "none",
              background: "var(--bg)",
              color: "var(--text)",
              boxSizing: "border-box",
            }}
          />
        </div>
      )}

      {/* Project → session list */}
      <div style={{ flex: explorerOpen && activeCwd ? "1 1 0" : "1 1 auto", overflowY: "auto", minHeight: 80, paddingBottom: 8 }}>
        {loading && (
          <div style={{ padding: "12px 16px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("sidebar.loading")}
          </div>
        )}
        {error && (
          <div style={{ padding: "12px 16px", color: "#f87171", fontSize: 12 }}>
            {error}
          </div>
        )}
        {!loading && !error && groups.length === 0 && (
          <div style={{ padding: "12px 16px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("sidebar.noSessions")}
          </div>
        )}
        {!loading && !error && groups.length > 0 && visibleGroups.length === 0 && (
          <div style={{ padding: "12px 16px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("sidebar.noMatches")}
          </div>
        )}
        {visibleGroups.map((group) => {
          const index = groupIndex.get(group.root) ?? Number.MAX_SAFE_INTEGER;
          const expanded = query
            ? true
            : projectExpansion[group.root] ?? (index < DEFAULT_EXPANDED_PROJECTS || group.root === activeProjectRoot);
          const name = projectDisplayName(group.root);
          const detail = (nameCounts.get(name) ?? 0) > 1 ? displayCwd(projectParentPath(group.root), homeDir) : null;
          const tree = expanded ? buildSessionTree(group.sessions) : [];
          const listExpanded = expandedSessionLists.has(group.root);
          const selectedHidden = !listExpanded
            && tree.slice(PROJECT_SESSION_PREVIEW).some((node) => treeContains(node, selectedSessionId));
          const showAll = Boolean(query) || listExpanded || selectedHidden;
          const visibleNodes = showAll ? tree : tree.slice(0, PROJECT_SESSION_PREVIEW);
          const hiddenCount = tree.length - visibleNodes.length;
          const projectPath = displayCwd(group.root, homeDir);
          return (
            <div key={group.root} style={{ marginBottom: 2 }}>
              <ProjectGroupHeader
                name={name}
                detail={detail}
                title={projectPath}
                expanded={expanded}
                active={group.root === activeProjectRoot}
                running={group.sessions.some((s) => runningSessionIds.has(s.id))}
                unread={group.sessions.some((s) => unreadSessionIds.has(s.id))}
                sessionCount={group.sessions.length}
                onToggle={() => toggleProject(group.root, expanded)}
                onNewSession={onNewSession ? () => startNewSession(group.root) : undefined}
                newSessionTitle={t("sidebar.newSessionTitle", { path: projectPath })}
              />
              {expanded && (
                <div role="group" aria-label={name}>
                  {visibleNodes.map((node) => (
                    <SessionTreeItem
                      key={node.session.id}
                      node={node}
                      selectedSessionId={selectedSessionId}
                      runningSessionIds={runningSessionIds}
                      unreadSessionIds={unreadSessionIds}
                      onSelectSession={onSelectSession}
                      onRenamed={loadSessions}
                      onSessionDeleted={(id) => {
                        onSessionDeleted?.(id);
                        loadSessions();
                      }}
                      depth={0}
                    />
                  ))}
                  {(hiddenCount > 0 || (listExpanded && !query && tree.length > PROJECT_SESSION_PREVIEW)) && (
                    <button
                      type="button"
                      className="sidebar-show-more"
                      onClick={() => toggleSessionList(group.root)}
                      style={{
                        display: "block",
                        height: 26,
                        margin: "0 6px",
                        padding: "0 0 0 30px",
                        border: "none",
                        background: "none",
                        color: "var(--text-dim)",
                        cursor: "pointer",
                        fontSize: 11.5,
                        textAlign: "left",
                      }}
                    >
                      {hiddenCount > 0 ? t("sidebar.showMore", { count: hiddenCount }) : t("sidebar.showLess")}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* File Explorer for the open chat's directory */}
      {activeCwd && (
        <div
          style={{
            borderTop: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            flex: explorerOpen ? "1 1 0" : "0 0 auto",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
            <button
              onClick={() => setExplorerOpen((v) => !v)}
              title={displayCwd(activeCwd, homeDir)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                flex: 1,
                minWidth: 0,
                padding: "6px 10px",
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                textAlign: "left",
              }}
            >
              <svg
                width="9" height="9" viewBox="0 0 10 10" fill="none"
                stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: explorerOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
              >
                <polyline points="3 2 7 5 3 8" />
              </svg>
              <span style={{ flexShrink: 0 }}>{t("files.explorer")}</span>
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textTransform: "none", letterSpacing: 0, fontWeight: 500, color: "var(--text-dim)" }}>
                {projectDisplayName(activeCwd)}
              </span>
              {explorerUploadBusy && <span role="status" aria-label={t("files.uploadBusy")}><FileSpinner size={12} /></span>}
            </button>
            {explorerOpen && changesCount > 0 && (
              <ToolbarIconButton
                onClick={() => setChangesCollapsed((v) => !v)}
                title={t("sidebar.changedFiles", { count: changesCount })}
                ariaPressed={!changesCollapsed}
                color={changesCollapsed ? "var(--text-dim)" : "var(--accent)"}
                background={changesCollapsed ? "none" : "var(--bg-selected)"}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M3 12h6" />
                  <path d="M15 12h6" />
                </svg>
              </ToolbarIconButton>
            )}
            {explorerOpen && (
              <ToolbarIconButton
                onClick={() => fileExplorerRef.current?.openUploadPicker()}
                disabled={explorerUploadBusy}
                title={t("sidebar.uploadFilesTitle")}
                color="var(--text-dim)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <path d="m17 8-5-5-5 5" />
                  <path d="M12 3v12" />
                </svg>
              </ToolbarIconButton>
            )}
            <ToolbarIconButton
              onClick={() => {
                if (onExplorerRefresh) onExplorerRefresh();
                else setExplorerKey((k) => k + 1);
                setExplorerRefreshDone(true);
                if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
                explorerRefreshTimerRef.current = setTimeout(() => setExplorerRefreshDone(false), 2000);
              }}
              title={t("sidebar.refreshExplorer")}
              skipHover={explorerRefreshDone}
              color={explorerRefreshDone ? "#4ade80" : "var(--text-dim)"}
              background={explorerRefreshDone ? "rgba(74,222,128,0.18)" : "none"}
              marginRight={6}
            >
              {explorerRefreshDone ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              )}
            </ToolbarIconButton>
          </div>
          <div style={{ display: explorerOpen ? "block" : "none", flex: 1, overflowY: "auto", overflowX: "hidden" }}>
            <FileExplorer
              ref={fileExplorerRef}
              cwd={activeCwd}
              onOpenFile={onOpenFile ?? (() => {})}
              refreshKey={explorerKey}
              onAtMention={onAtMention}
              onAtMentions={onAtMentions}
              onUploadBusyChange={setExplorerUploadBusy}
              changesCollapsed={changesCollapsed}
              onChangesCountChange={setChangesCount}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectGroupHeader({
  name,
  detail,
  title,
  expanded,
  active,
  running,
  unread,
  sessionCount,
  onToggle,
  onNewSession,
  newSessionTitle,
}: {
  name: string;
  /** Parent path shown when several projects share a name. */
  detail: string | null;
  title: string;
  expanded: boolean;
  active: boolean;
  running: boolean;
  unread: boolean;
  sessionCount: number;
  onToggle: () => void;
  onNewSession?: () => void;
  newSessionTitle: string;
}) {
  const { t } = useI18n();
  return (
    <div
      className="sidebar-project-row"
      style={{ display: "flex", alignItems: "center", height: 30, margin: "0 6px", paddingRight: 4, borderRadius: 6, transition: "background 0.1s" }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        title={title}
        style={{
          flex: 1,
          minWidth: 0,
          height: "100%",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "0 4px 0 8px",
          border: "none",
          background: "none",
          color: active ? "var(--text)" : "var(--text-muted)",
          cursor: "pointer",
          textAlign: "left",
          fontSize: 12.5,
          fontWeight: active ? 600 : 500,
        }}
      >
        <svg
          width="9" height="9" viewBox="0 0 10 10" fill="none"
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          style={{ flexShrink: 0, color: "var(--text-dim)", transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
        >
          <polyline points="3 2 7 5 3 8" />
        </svg>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, color: active ? "var(--accent)" : "var(--text-dim)" }}>
          {expanded ? (
            <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
          ) : (
            <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
          )}
        </svg>
        <span style={{ flex: detail ? "0 1 auto" : 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name}
        </span>
        {detail && (
          <PathLabel text={detail} style={{ flex: 1, fontSize: 10.5, fontWeight: 400, fontFamily: "var(--font-mono)", color: "var(--text-dim)" }} />
        )}
        {!expanded && running && <RunningSessionIndicator label={t("sidebar.projectRunning")} />}
        {!expanded && !running && unread && <UnreadSessionIndicator label={t("sidebar.projectUnread")} />}
      </button>
      <span
        className="sidebar-project-count"
        aria-hidden="true"
        style={{ flexShrink: 0, minWidth: 24, textAlign: "center", fontSize: 10.5, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}
      >
        {sessionCount}
      </span>
      {onNewSession && (
        <button
          type="button"
          className="sidebar-project-new"
          onClick={onNewSession}
          title={newSessionTitle}
          aria-label={newSessionTitle}
          style={{
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            padding: 0,
            border: "none",
            borderRadius: 5,
            background: "none",
            color: "var(--text-dim)",
            cursor: "pointer",
            flexShrink: 0,
            transition: "color 0.12s, background 0.12s",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </button>
      )}
    </div>
  );
}

function SessionTreeItem({
  node,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  depth,
}: {
  node: SessionTreeNode;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  depth: number;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div style={{ position: "relative" }}>
        {/* Indent guide for forked sessions */}
        {depth > 0 && (
          <div style={{
            position: "absolute",
            left: 41 + (depth - 1) * 14,
            top: 0, bottom: 0,
            width: 1,
            background: "var(--border)",
            pointerEvents: "none",
          }} />
        )}
        <SessionItem
          session={node.session}
          isSelected={node.session.id === selectedSessionId}
          isRunning={runningSessionIds.has(node.session.id)}
          isUnread={unreadSessionIds.has(node.session.id)}
          onClick={() => onSelectSession(node.session)}
          onRenamed={onRenamed}
          onDeleted={(id) => onSessionDeleted?.(id)}
          depth={depth}
          hasChildren={hasChildren}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
        />
      </div>
      {hasChildren && !collapsed && (
        <div>
          {node.children.map((child) => (
            <SessionTreeItem
              key={child.session.id}
              node={child}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
              unreadSessionIds={unreadSessionIds}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RunningSessionIndicator({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <span
      title={label ?? t("sidebar.agentRunning")}
      aria-label={label ?? t("sidebar.agentRunning")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--accent)",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <g>
          <path
            d="M21 12a9 9 0 1 1-3.8-7.4"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinecap="round"
          />
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </g>
      </svg>
    </span>
  );
}

function UnreadSessionIndicator({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <span
      title={label ?? t("sidebar.newActivity")}
      aria-label={label ?? t("sidebar.newSessionActivity")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "#0891b2",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <circle cx="7" cy="7" r="2.5" fill="currentColor" />
        <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.4" opacity="0.32">
          <animate attributeName="r" values="3;6;3" dur="1.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.32;0;0.32" dur="1.6s" repeatCount="indefinite" />
        </circle>
      </svg>
    </span>
  );
}

function SessionItem({
  session,
  isSelected,
  isRunning,
  isUnread,
  onClick,
  onRenamed,
  onDeleted,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
}: {
  session: SessionInfo;
  isSelected: boolean;
  isRunning?: boolean;
  isUnread?: boolean;
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const title = session.name?.trim() || t("sidebar.untitledSession");
  const engine = session.engine ?? engineForSession(session.id);
  const tooltip = [
    title,
    `${engineLabel(engine)} · ${t("sidebar.messagesCount", { count: session.messageCount })}`,
    session.worktreeBranch ? t("sidebar.worktreePath", { path: session.cwd }) : "",
  ].filter(Boolean).join("\n");

  const startRename = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setRenameValue(session.name ?? "");
    setRenaming(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [session.name]);

  const commitRename = useCallback(async () => {
    const name = renameValue.trim();
    setRenaming(false);
    if (name === (session.name ?? "")) return;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error("Rename failed");
      historyClientCache.invalidate(session.id);
      onRenamed?.();
    } catch {
      // ignore
    }
  }, [renameValue, session.id, session.name, onRenamed]);

  const performDelete = useCallback(async () => {
    setConfirmDelete(false);
    setDeleteError(null);
    setDeleting(true);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || "Delete failed");
      }
      historyClientCache.invalidate(session.id);
      onDeleted?.(session.id);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Delete failed");
      setDeleting(false);
    }
  }, [session.id, onDeleted]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.shiftKey) {
      void performDelete();
    } else {
      setConfirmDelete(true);
    }
  }, [performDelete]);

  const handleDeleteConfirm = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    void performDelete();
  }, [performDelete]);

  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);

  // Fixed-height row — content swaps in place so the list never reflows
  const ITEM_HEIGHT = 32;
  const actionButtonStyle: React.CSSProperties = {
    display: "flex", alignItems: "center", justifyContent: "center",
    width: 24, height: 24, padding: 0,
    background: "none", border: "none",
    borderRadius: 5, color: "var(--text-dim)",
    cursor: "pointer", flexShrink: 0,
    transition: "background 0.12s, color 0.12s",
  };

  return (
    <div
      className="sidebar-session-row"
      onClick={confirmDelete || renaming ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      title={confirmDelete || renaming ? undefined : tooltip}
      aria-current={isSelected ? "page" : undefined}
      style={{
        height: ITEM_HEIGHT,
        display: "flex",
        alignItems: "center",
        margin: "0 6px",
        paddingLeft: 30 + depth * 14,
        paddingRight: 4,
        borderRadius: 6,
        cursor: confirmDelete || renaming ? "default" : "pointer",
        background: confirmDelete
          ? "rgba(239,68,68,0.08)"
          : isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        transition: "background 0.1s",
        opacity: deleting ? 0.5 : 1,
        gap: 6,
        overflow: "hidden",
      }}
    >
      {confirmDelete ? (
        /* ── Delete confirmation: same height, two flat buttons ── */
        <>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("sidebar.deleteSession", { title: title.slice(0, 22) + (title.length > 22 ? "…" : "") })}
          </div>
          <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
            <button
              onClick={handleDeleteConfirm}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                height: 24, padding: "0 9px",
                background: "#ef4444", border: "none",
                borderRadius: 5, color: "#fff",
                cursor: "pointer", fontSize: 11.5, fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              {t("sidebar.delete")}
            </button>
            <button
              onClick={handleDeleteCancel}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                height: 24, padding: "0 9px",
                background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 5, color: "var(--text-muted)",
                cursor: "pointer", fontSize: 11.5, fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              {t("sidebar.cancel")}
            </button>
          </div>
        </>
      ) : renaming ? (
        /* ── Rename: input fills the same row ── */
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            padding: "3px 8px",
            border: "1px solid var(--accent)",
            borderRadius: 5,
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
            height: 26,
          }}
        />
      ) : (
        /* ── Normal view: title on the left, age (or actions) on the right ── */
        <>
          {/* Fork indicator for child sessions */}
          {depth > 0 && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          )}
          {isRunning ? <RunningSessionIndicator /> : isUnread ? <UnreadSessionIndicator /> : null}
          {deleteError ? (
            <span role="alert" title={deleteError} style={{ flex: 1, minWidth: 0, color: "#ef4444", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {deleteError}
            </span>
          ) : (
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontSize: 12.5,
                lineHeight: 1.4,
                fontWeight: isSelected ? 500 : 400,
                color: isSelected ? "var(--text)" : "var(--text-muted)",
              }}
            >
              {title}
            </span>
          )}
          {session.worktreeBranch && (
            <span
              style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 1, maxWidth: 90, minWidth: 0, color: "var(--accent)", fontSize: 10.5, overflow: "hidden" }}
            >
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <line x1="6" y1="3" x2="6" y2="15" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.worktreeBranch}</span>
            </span>
          )}

          {/* Collapse toggle — always visible when has children */}
          {hasChildren && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
              title={collapsed ? t("sidebar.expandForks") : t("sidebar.collapseForks")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 18, height: 18, padding: 0, flexShrink: 0,
                background: "none", border: "none",
                color: "var(--text-dim)", cursor: "pointer",
                transform: collapsed ? "rotate(-90deg)" : "none",
                transition: "transform 0.15s",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          )}

          {/* Selected rows also expose actions for touch/keyboard users. */}
          {(hovered || isSelected) ? (
            <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
              <button
                onClick={startRename}
                title={t("sidebar.rename")}
                style={actionButtonStyle}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--accent)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "none";
                  e.currentTarget.style.color = "var(--text-dim)";
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
              {supportsSessionDeletion(engineForSession(session.id)) && <button
                onClick={handleDeleteClick}
                disabled={deleting}
                title={t("sidebar.deleteWithShiftClick")}
                style={actionButtonStyle}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(239,68,68,0.08)";
                  e.currentTarget.style.color = "#ef4444";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "none";
                  e.currentTarget.style.color = "var(--text-dim)";
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>}
            </div>
          ) : (
            <span style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0, color: "var(--text-dim)", fontSize: 11 }}>
              <span style={{ padding: "0 3px", border: "1px solid var(--border)", borderRadius: 3, fontSize: 9, lineHeight: "13px", fontFamily: "var(--font-mono)" }}>
                {engineLabel(engine)}
              </span>
              <span title={session.modified} style={{ minWidth: 22, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                {formatRelativeTime(session.modified)}
              </span>
            </span>
          )}
        </>
      )}
    </div>
  );
}
