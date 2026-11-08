import { isAbsolute } from "node:path";

type SessionInfoReader = (sessionId: string, options: { dir: string }) => Promise<{ customTitle?: unknown } | undefined>;
type CachedTitle = { projectionMtimeMs: number; checkedAt: number; title?: string };

declare global {
  var __ompWebClaudeNativeTitles: Map<string, CachedTitle> | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TITLE_LENGTH = 200;
const FOUND_TTL_MS = 5 * 60_000;
const MISSING_TTL_MS = 30_000;

// Same native CLAUDE_CONFIG_DIR/HOME resolution as session deletion; loaded lazily
// so listing other engines never initializes the Claude SDK.
const readNativeSessionInfo: SessionInfoReader = async (sessionId, options) => {
  const { getSessionInfo } = await import("@anthropic-ai/claude-agent-sdk");
  return getSessionInfo(sessionId, options);
};

/**
 * Claude Code's own title for a native session: the latest /rename
 * (`custom-title`), else its generated `ai-title`. The SDK exposes both as
 * `customTitle`; its `summary` is NOT used because it falls back to prompt text.
 * Read-only: never appends to, rewrites or creates the native transcript.
 */
export async function readClaudeNativeTitle(nativeId: string, cwd: string, read: SessionInfoReader = readNativeSessionInfo): Promise<string | undefined> {
  if (!UUID.test(nativeId) || !cwd || !isAbsolute(cwd)) return undefined;
  try {
    const title = (await read(nativeId, { dir: cwd }))?.customTitle;
    const clean = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
    return clean ? Array.from(clean).slice(0, MAX_TITLE_LENGTH).join("") : undefined;
  } catch {
    return undefined; // Missing or unreadable native history leaves the session untitled.
  }
}

/** Sidebar lookup, reused while the web projection is unchanged and the result is recent. */
export async function cachedClaudeNativeTitle(
  sessionId: string,
  nativeId: string,
  cwd: string,
  projectionMtimeMs: number,
  read?: SessionInfoReader,
): Promise<string | undefined> {
  const cache = globalThis.__ompWebClaudeNativeTitles ??= new Map();
  const hit = cache.get(sessionId);
  if (hit && hit.projectionMtimeMs === projectionMtimeMs && Date.now() - hit.checkedAt < (hit.title ? FOUND_TTL_MS : MISSING_TTL_MS)) return hit.title;
  const title = await readClaudeNativeTitle(nativeId, cwd, read);
  cache.delete(sessionId);
  cache.set(sessionId, { projectionMtimeMs, checkedAt: Date.now(), title });
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  return title;
}

/** A live session found a newer native title: the next sidebar listing must re-read it. */
export function forgetClaudeNativeTitle(sessionId: string): void {
  globalThis.__ompWebClaudeNativeTitles?.delete(sessionId);
}
