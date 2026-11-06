import {
  SessionManager,
  buildContextEntries as piBuildContextEntries,
  buildSessionContext as piBuildSessionContext,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "fs";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "fs";
import { join, normalize as normalizePath } from "path";
import type { AgentMessage, SessionEntry, SessionHeader, SessionInfo, SessionContext, SessionTreeNode } from "./types";
import type { SessionEntry as PiSessionEntry, SessionInfo as PiSessionInfo } from "@earendil-works/pi-coding-agent";
import { normalizeToolCalls } from "./normalize";
import { sessionPathKey } from "./session-path";
import { resolveProject, type ProjectInfo } from "./worktree";

import { getEngineAgentDir } from "./engine-paths";
import { engineForSession, sessionKey, type AgentEngine } from "./engine";
export { getOmpAgentDir as getAgentDir } from "./file-paths";

async function loadEngineSessions(engine: AgentEngine): Promise<SessionInfo[]> {
  const sessionsDir = join(getEngineAgentDir(engine), "sessions");
  if (!existsSync(sessionsDir)) return [];
  const directories = [sessionsDir];
  for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) directories.push(join(sessionsDir, entry.name));
  }
  // An explicit SDK listAll directory is flat, not an agent root. Scan each
  // project directory explicitly; never rely on the web process's Pi env.
  const groups = await Promise.all(directories.map(async (directory) => {
    try { return await SessionManager.listAll(directory); } catch { return []; }
  }));
  const piSessions: Omit<PiSessionInfo, "allMessagesText">[] = groups.flat();
  const knownPaths = new Set(piSessions.map((s) => sessionPathKey(s.path)));
  // Native OMP title slots can precede the header, which Pi's indexer skips.
  for (const directory of directories) {
    try {
      for (const file of readdirSync(directory).filter((name) => name.endsWith(".jsonl"))) {
        const filePath = join(directory, file);
        if (knownPaths.has(sessionPathKey(filePath))) continue;
        const header = readSessionHeader(filePath);
        if (!header?.id) continue;
        const stat = statSync(filePath);
        piSessions.push({
          path: filePath,
          id: header.id,
          cwd: header.cwd || "",
          name: header.title,
          created: header.timestamp ? new Date(header.timestamp) : stat.birthtime,
          modified: stat.mtime,
          messageCount: 1,
          firstMessage: header.title || "(session)",
          parentSessionPath: header.parentSession,
        });
        knownPaths.add(sessionPathKey(filePath));
      }
    } catch { /* A concurrently removed project/session must not hide other histories. */ }
  }
  const pathToId = new Map<string, string>();
  for (const s of piSessions) pathToId.set(sessionPathKey(s.path), sessionKey(engine, s.id));
  const nativeIds = new Set(piSessions.map((s) => s.id));
  // Resolve each unique cwd to its project root (main repo shared by all
  // worktrees). resolveProject caches per-cwd, so this is cheap after warmup.
  const uniqueCwds = [...new Set(piSessions.map((s) => s.cwd).filter(Boolean))];
  const projectByCwd = new Map<string, ProjectInfo>();
  await Promise.all(uniqueCwds.map(async (cwd) => {
    projectByCwd.set(cwd, await resolveProject(cwd));
  }));

  return piSessions.map((s) => {
    const id = sessionKey(engine, s.id);
    cacheSessionPath(id, s.path);
    const header = readSessionHeader(s.path);
    const project = s.cwd ? projectByCwd.get(s.cwd) : undefined;
    const parent = header?.parentSession ?? s.parentSessionPath;
    return {
      path: s.path,
      id,
      engine,
      cwd: s.cwd,
      name: header?.title ?? s.name,
      created: s.created instanceof Date ? s.created.toISOString() : String(s.created),
      modified: s.modified instanceof Date ? s.modified.toISOString() : String(s.modified),
      messageCount: s.messageCount,
      firstMessage: s.firstMessage || "(no messages)",
      parentSessionId: parent ? pathToId.get(sessionPathKey(parent)) ?? (nativeIds.has(parent) ? sessionKey(engine, parent) : undefined) : undefined,
      projectRoot: project?.projectRoot ?? s.cwd,
      ...(project?.isWorktree && project.branch ? { worktreeBranch: project.branch } : {}),
    };
  });
}

async function loadAllSessions(): Promise<SessionInfo[]> {
  const groups = await Promise.all([loadEngineSessions("omp"), loadEngineSessions("pi"), loadEngineSessions("claude"), loadEngineSessions("codex")]);
  return groups.flat().sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
}

export async function listAllSessions(): Promise<SessionInfo[]> {
  const generation = globalThis.__piSessionListGeneration ?? 0;

  // Return cached result if still fresh (avoids re-scanning session files
  // and re-spawning git processes on every page load).
  if (globalThis.__piSessionListCache && Date.now() - globalThis.__piSessionListCache.ts < SESSION_LIST_CACHE_TTL_MS) {
    return globalThis.__piSessionListCache.data;
  }

  // Coalescing dedup: concurrent callers share the same in-flight promise
  // only while it belongs to the current cache generation.
  if (globalThis.__piSessionListPromise && globalThis.__piSessionListPromiseGeneration === generation) {
    return globalThis.__piSessionListPromise;
  }

  const loadPromise = loadAllSessions().then((data) => {
    // An invalidation may happen while the scan is in flight. Do not let that
    // older result repopulate the cache after a session mutation.
    if ((globalThis.__piSessionListGeneration ?? 0) === generation) {
      globalThis.__piSessionListCache = { data, ts: Date.now() };
    }
    return data;
  });
  const trackedPromise = loadPromise.finally(() => {
    if (globalThis.__piSessionListPromise === trackedPromise) {
      globalThis.__piSessionListPromise = undefined;
      globalThis.__piSessionListPromiseGeneration = undefined;
    }
  });

  globalThis.__piSessionListPromise = trackedPromise;
  globalThis.__piSessionListPromiseGeneration = generation;
  return trackedPromise;
}

// ============================================================================
// Session path caches, stored in globalThis for hot-reload safety.
// ============================================================================
declare global {
  var __piSessionPathCache: Map<string, string> | undefined;
  var __piPathToSessionIdCache: Map<string, string> | undefined;
  var __piSessionListPromise: Promise<SessionInfo[]> | undefined;
  var __piSessionListPromiseGeneration: number | undefined;
  var __piSessionListGeneration: number | undefined;
  var __piSessionListCache: { data: SessionInfo[]; ts: number } | undefined;
}

const SESSION_LIST_CACHE_TTL_MS = 30_000;

export function invalidateSessionListCache(): void {
  globalThis.__piSessionListGeneration = (globalThis.__piSessionListGeneration ?? 0) + 1;
  globalThis.__piSessionListCache = undefined;
}

function getPathCache(): Map<string, string> {
  if (!globalThis.__piSessionPathCache) globalThis.__piSessionPathCache = new Map();
  return globalThis.__piSessionPathCache;
}

function getPathToIdCache(): Map<string, string> {
  if (!globalThis.__piPathToSessionIdCache) globalThis.__piPathToSessionIdCache = new Map();
  return globalThis.__piPathToSessionIdCache;
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached) return cached;

  // Cache miss: scan all sessions to populate cache, then retry
  await listAllSessions();
  return getPathCache().get(sessionId) ?? null;
}

export async function resolveSessionIdByPath(filePath: string, engine: AgentEngine = "omp"): Promise<string | undefined> {
  // Resolve native parent IDs only within the child's engine namespace.
  const id = sessionKey(engine, filePath);
  if (getPathCache().has(id)) return id;
  const pathKey = sessionPathKey(filePath);
  const cached = getPathToIdCache().get(pathKey);
  if (cached) return engineForSession(cached) === engine ? cached : undefined;

  await listAllSessions();
  if (getPathCache().has(id)) return id;
  const resolved = getPathToIdCache().get(pathKey);
  return resolved && engineForSession(resolved) === engine ? resolved : undefined;
}

export function cacheSessionPath(sessionId: string, filePath: string): void {
  const normalizedPath = normalizePath(filePath);
  const pathKey = sessionPathKey(normalizedPath);
  const pathCache = getPathCache();
  const reverseCache = getPathToIdCache();
  const previousPath = pathCache.get(sessionId);
  const previousPathKey = previousPath ? sessionPathKey(previousPath) : undefined;
  const previousSessionId = reverseCache.get(pathKey);
  const previousOwnerPath = previousSessionId ? pathCache.get(previousSessionId) : undefined;
  if (previousPathKey && previousPathKey !== pathKey && reverseCache.get(previousPathKey) === sessionId) {
    reverseCache.delete(previousPathKey);
  }
  if (
    previousSessionId &&
    previousSessionId !== sessionId &&
    previousOwnerPath &&
    sessionPathKey(previousOwnerPath) === pathKey
  ) {
    pathCache.delete(previousSessionId);
  }
  pathCache.set(sessionId, normalizedPath);
  reverseCache.set(pathKey, sessionId);
}

export function invalidateSessionPathCache(sessionId: string): void {
  const pathCache = getPathCache();
  const reverseCache = getPathToIdCache();
  const filePath = pathCache.get(sessionId);
  pathCache.delete(sessionId);
  const pathKey = filePath ? sessionPathKey(filePath) : undefined;
  if (pathKey && reverseCache.get(pathKey) === sessionId) {
    reverseCache.delete(pathKey);
  }
}

export function readSessionHeader(filePath: string): SessionHeader | null {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead === 0) return null;
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = text.split("\n");
    let sessionHeader: (SessionHeader & { name?: string; title?: string }) | null = null;
    let slotTitle: string | undefined;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line.trim()) as Record<string, unknown>;
        if (entry?.type === "title" && typeof entry.title === "string") {
          slotTitle = entry.title;
        } else if (entry && entry.type === "session" && !sessionHeader) {
          sessionHeader = entry as unknown as SessionHeader;
        } else if (entry && entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) {
          if (sessionHeader) {
            sessionHeader.name = entry.name.trim();
            sessionHeader.title = entry.name.trim();
          }
        }
      } catch {
        // continue scanning
      }
    }
    if (sessionHeader && slotTitle !== undefined) sessionHeader.title = slotTitle;
    return sessionHeader;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function hasSessionType(entry: unknown): boolean {
  return Boolean(entry && typeof entry === "object" && (entry as { type?: unknown }).type === "session");
}

export function loadOmpSessionEntries(filePath: string): SessionEntry[] {
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n");
    const entries: SessionEntry[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line.trim()) as SessionEntry);
      } catch {
        // ignore invalid lines
      }
    }
    // OMP's fixed-width title slot intentionally precedes its session header.
    // Browsing must NEVER reorder/rewrite a transcript owned by a live OMP process.
    return entries;
  } catch {
    return [];
  }
}

// A read-only structural view, not a Pi SessionManager (which can migrate/write
// files on construction). Mutations belong exclusively to the native OMP RPC.
export function openSessionManager(filePath: string) {
  const raw = loadOmpSessionEntries(filePath);
  const header = readSessionHeader(filePath);
  const entries = raw.filter((entry) => !hasSessionType(entry) && typeof entry.id === "string");
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const last = entries.at(-1) as (SessionEntry & { activeLeafId?: string | null }) | undefined;
  let leafId = last?.activeLeafId !== undefined ? last.activeLeafId : last?.id ?? null;
  if (leafId !== null && !byId.has(leafId)) {
    leafId = [...entries].reverse().find((entry) => {
      const active = (entry as SessionEntry & { activeLeafId?: string | null }).activeLeafId;
      return active === undefined || active === entry.id;
    })?.id ?? null;
  }
  return {
    getHeader: () => header,
    getEntries: () => entries,
    getLeafId: () => leafId,
    getSessionName: () => {
      for (let i = raw.length - 1; i >= 0; i--) {
        const entry = raw[i] as unknown as Record<string, unknown>;
        if (entry.type === "title_change" && typeof entry.title === "string") return entry.title;
        if (entry.type === "session_info" && typeof entry.name === "string") return entry.name;
      }
      return header?.title;
    },
    getTree: (): SessionTreeNode[] => {
      const nodes = new Map<string, SessionTreeNode>(entries.map((entry) => [entry.id, { entry, children: [] }]));
      const roots: SessionTreeNode[] = [];
      for (const node of nodes.values()) {
        const parent = node.entry.parentId ? nodes.get(node.entry.parentId) : undefined;
        if (parent && parent !== node) parent.children.push(node);
        else roots.push(node);
        if (node.entry.type === "label") {
          const target = nodes.get(node.entry.targetId);
          if (target) target.label = node.entry.label;
        }
      }
      return roots;
    },
  };
}
export function getSessionEntries(filePath: string): SessionEntry[] {
  const sm = openSessionManager(filePath);
  return sm.getEntries() as unknown as SessionEntry[];
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean } = {},
): SessionContext {
  // Adapt OMP metadata in memory only. Non-default role changes must not replace
  // the chat model, but retain their ids/parents so branch traversal stays intact.
  const piEntries = entries.map((entry) => {
    const raw = entry as unknown as Record<string, unknown>;
    if (raw.type !== "model_change" || typeof raw.model !== "string") return entry;
    if (raw.role && raw.role !== "default") return { ...entry, type: "custom", customType: "omp_model_role" };
    const slash = raw.model.indexOf("/");
    return slash > 0 ? { ...entry, provider: raw.model.slice(0, slash), modelId: raw.model.slice(slash + 1) } : entry;
  }) as unknown as PiSessionEntry[];
  const contextById = new Map(piEntries.map((entry) => [entry.id, entry]));
  const piCtx = piBuildSessionContext(piEntries, leafId, contextById);

  const contextEntries = piBuildContextEntries(
    piEntries,
    leafId,
    contextById,
  );

  // Convert the SDK-selected context entries and their IDs together. This keeps
  // fork/navigation targets aligned while preserving pi's compaction ordering.
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  for (const entry of contextEntries) {
    const localEntry = entry as unknown as SessionEntry;
    const m = entryToUiMessage(localEntry, options);
    if (m) {
      messages.push(m);
      entryIds.push(localEntry.id);
    }
  }

  return {
    messages,
    entryIds,
    thinkingLevel: piCtx.thinkingLevel,
    model: piCtx.model,
  };
}

function parseEntryTimestamp(timestamp: string): number | undefined {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64ImageInfo(block: unknown): { bytes: number; mime?: string } | null {
  if (!isRecord(block) || block.type !== "image") return null;

  let data: string | undefined;
  let mime: string | undefined;
  if (typeof block.data === "string") {
    data = block.data;
    mime = typeof block.mimeType === "string" ? block.mimeType : undefined;
  } else if (isRecord(block.source) && block.source.type === "base64" && typeof block.source.data === "string") {
    data = block.source.data;
    mime = typeof block.source.media_type === "string" ? block.source.media_type : undefined;
  }
  if (!data) return null;

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return { bytes: Math.max(0, Math.floor(data.length * 3 / 4) - padding), mime };
}

function omitToolResultBase64Images(message: AgentMessage): AgentMessage {
  if (message.role !== "toolResult") return message;

  let omitted = 0;
  let bytes = 0;
  const mimes = new Set<string>();
  const content = message.content.filter((block) => {
    const image = base64ImageInfo(block);
    if (!image) return true;
    omitted += 1;
    bytes += image.bytes;
    if (image.mime) mimes.add(image.mime);
    return false;
  });
  if (omitted === 0) return message;

  const mimeText = mimes.size > 0 ? `: ${[...mimes].join(", ")}` : "";
  content.push({
    type: "text",
    text: `[${omitted} tool result image${omitted === 1 ? "" : "s"} omitted from initial history payload${mimeText}, ~${bytes} bytes]`,
  });
  return { ...message, content };
}

// Convert a session entry on the active branch into a UI message.
// Returns null for entries that do not map to chat history (metadata, non-message types).
function entryToUiMessage(
  entry: SessionEntry,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean },
): AgentMessage | null {
  // Supported message roles: user, assistant, toolResult, bashExecution.
  // bashExecution messages enter the case "message" branch (entry.type === "message").
  // The early return at line below ("!options.deferThinking || message.role !== "assistant"")
  // passes non-assistant messages — including bashExecution — through unchanged.
  // normalizeToolCalls is a secondary guard (returns non-assistant messages as-is).
  switch (entry.type) {
    case "message": {
      const message = options.deferToolResultImages
        ? omitToolResultBase64Images(normalizeToolCalls(entry.message))
        : normalizeToolCalls(entry.message);
      if (!options.deferThinking || message.role !== "assistant") return message;
      return {
        ...message,
        content: message.content.map((block) => (
          block.type === "thinking" && block.thinking.trim() !== ""
            ? { ...block, thinking: "", deferred: true }
            : block
        )),
      };
    }
    case "compaction":
      return {
        role: "custom",
        customType: "compaction",
        content: entry.summary,
        display: true,
        details: {
          tokensBefore: entry.tokensBefore,
          firstKeptEntryId: entry.firstKeptEntryId,
        },
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "branch_summary":
      if (!entry.summary) return null;
      return {
        role: "user",
        content: `*The conversation briefly explored another branch and returned with this summary:*\n\n${entry.summary}`,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "custom_message":
      return {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    default:
      return null;
  }
}
