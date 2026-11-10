import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { resolveContextUsage } from "./context-usage";
import type { ContextUsage } from "./pi-types";

type Persistence = { path: string; timer?: ReturnType<typeof setTimeout> };

declare global {
  var __ompWebLastContextUsage: Map<string, ContextUsage> | undefined;
  var __ompWebContextUsagePersistence: Persistence | undefined;
}

const MAX_SESSIONS = 500;
const SAVE_DELAY_MS = 1000;
const FILE_VERSION = 1;

function store(): Map<string, ContextUsage> {
  globalThis.__ompWebLastContextUsage ??= new Map();
  return globalThis.__ompWebLastContextUsage;
}

function same(a: ContextUsage, b: ContextUsage): boolean {
  return a.contextWindow === b.contextWindow && a.tokens === b.tokens && a.percent === b.percent;
}

function trim(map: Map<string, ContextUsage>): void {
  while (map.size > MAX_SESSIONS) map.delete(map.keys().next().value!);
}

export function defaultContextUsageStatePath(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "omp-web", "context-usage.json");
}

/** Write now; the debounced save calls this. Never throws: this is display metadata. */
export function flushContextUsage(): void {
  const persistence = globalThis.__ompWebContextUsagePersistence;
  if (!persistence) return;
  clearTimeout(persistence.timer);
  persistence.timer = undefined;
  try {
    mkdirSync(dirname(persistence.path), { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(persistence.path, JSON.stringify({ version: FILE_VERSION, sessions: [...store()] }));
  } catch { /* The in-memory value stays usable; the next change saves again. */ }
}

function scheduleSave(): void {
  const persistence = globalThis.__ompWebContextUsagePersistence;
  if (!persistence || persistence.timer) return;
  persistence.timer = setTimeout(flushContextUsage, SAVE_DELAY_MS);
  persistence.timer.unref?.();
}

/**
 * Server start only (instrumentation): keep the last native reports across
 * service restarts, so an idle history still shows what its engine last said.
 * Tests and tools never call this and stay memory-only. Saved entries are older
 * than any report received since this process started, which therefore win.
 */
export function enableContextUsagePersistence(path = defaultContextUsageStatePath()): void {
  if (globalThis.__ompWebContextUsagePersistence) return;
  globalThis.__ompWebContextUsagePersistence = { path };
  let saved: unknown[] = [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; sessions?: unknown };
    if (parsed?.version === FILE_VERSION && Array.isArray(parsed.sessions)) saved = parsed.sessions;
  } catch { return; /* Missing or unreadable: start empty and overwrite on the next report. */ }
  const map = store();
  const live = [...map];
  map.clear();
  for (const entry of saved) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || !entry[0]) continue;
    const usage = resolveContextUsage(entry[1] as ContextUsage);
    if (usage) { map.delete(entry[0]); map.set(entry[0], usage); }
  }
  for (const [id, usage] of live) { map.delete(id); map.set(id, usage); }
  trim(map);
}

/**
 * Remember the latest value a native engine reported for a web session, so an
 * idle-closed history can still show it. Display-only: it is never derived from
 * transcript tokens and never sent back to an engine. An explicit unknown (for
 * example after a model switch) forgets the old value.
 */
export function rememberContextUsage(sessionId: string, value: unknown): void {
  if (!sessionId || value === undefined) return;
  const map = store();
  const usage = resolveContextUsage(value as ContextUsage | null);
  const previous = map.get(sessionId);
  map.delete(sessionId);
  if (!usage) {
    if (previous) scheduleSave();
    return;
  }
  map.set(sessionId, usage);
  trim(map);
  // State polls repeat the same report; only a changed value needs a write.
  if (!previous || !same(previous, usage)) scheduleSave();
}

export function lastContextUsage(sessionId: string): ContextUsage | undefined {
  return store().get(sessionId);
}

export function forgetContextUsage(sessionId: string): void {
  if (store().delete(sessionId)) scheduleSave();
}
