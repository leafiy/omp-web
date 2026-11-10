import type { SessionInfo } from "./types";

/** Working directory of a new chat when the user does not choose one. */
export const DEFAULT_NEW_SESSION_CWD = "/tmp";

export interface SessionProjectGroup {
  /** Main project root shared by its worktrees (the cwd itself for non-git directories). */
  root: string;
  /** Sessions of every worktree/subdirectory that resolve to this root. */
  sessions: SessionInfo[];
  /** Most recent `modified` timestamp among the group's sessions. */
  latest: string;
}

/** Project identity of a session; worktrees collapse into their main repo. */
export function sessionProjectRoot(session: Pick<SessionInfo, "projectRoot" | "cwd">): string | null {
  return session.projectRoot || session.cwd || null;
}

/**
 * Group sessions by project root, most recently active project first.
 * Sessions keep their incoming order inside a group; callers build fork trees.
 */
export function groupSessionsByProject(sessions: readonly SessionInfo[]): SessionProjectGroup[] {
  const groups = new Map<string, SessionProjectGroup>();
  for (const session of sessions) {
    const root = sessionProjectRoot(session);
    if (!root) continue;
    const group = groups.get(root);
    if (!group) {
      groups.set(root, { root, sessions: [session], latest: session.modified });
      continue;
    }
    group.sessions.push(session);
    if (session.modified > group.latest) group.latest = session.modified;
  }
  return [...groups.values()].sort((a, b) => b.latest.localeCompare(a.latest) || a.root.localeCompare(b.root));
}

/** Project roots ordered by most recent session activity. */
export function getRecentProjects(sessions: readonly SessionInfo[]): string[] {
  return groupSessionsByProject(sessions).map((group) => group.root);
}

/** Last path segment for display ("/home/me/omp-web" → "omp-web"; "/" stays "/"). */
export function projectDisplayName(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || root;
}

/**
 * Folder in which "New project" creates its directory: the parent holding the
 * most recent projects (ties go to the more recent one), else `fallback`.
 * Filesystem roots and the temporary default directory are never suggested.
 */
export function newProjectParent(projects: readonly string[], fallback: string): string {
  const counts = new Map<string, number>();
  for (const project of projects) {
    const parent = projectParentPath(project);
    if (!parent || /^(?:[\\/]|[a-zA-Z]:[\\/]?)$/.test(parent)) continue;
    if (parent === DEFAULT_NEW_SESSION_CWD || parent.startsWith(`${DEFAULT_NEW_SESSION_CWD}/`)) continue;
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  let best = fallback;
  let bestCount = 0;
  for (const [parent, count] of counts) {
    if (count > bestCount) {
      best = parent;
      bestCount = count;
    }
  }
  return best;
}

/** Parent directory of a project root, used to tell same-named projects apart. */
export function projectParentPath(root: string): string {
  const trimmed = root.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index < 0) return "";
  return index === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, index);
}
