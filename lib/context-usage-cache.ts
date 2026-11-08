import { resolveContextUsage } from "./context-usage";
import type { ContextUsage } from "./pi-types";

declare global {
  var __ompWebLastContextUsage: Map<string, ContextUsage> | undefined;
}

const MAX_SESSIONS = 500;

function store(): Map<string, ContextUsage> {
  globalThis.__ompWebLastContextUsage ??= new Map();
  return globalThis.__ompWebLastContextUsage;
}

/**
 * Remember the latest value a native engine reported for a web session, so an
 * idle-closed history can still show it. Display-only and process-local: it is
 * never derived from transcript tokens and never sent back to an engine. An
 * explicit unknown (for example after a model switch) forgets the old value.
 */
export function rememberContextUsage(sessionId: string, value: unknown): void {
  if (!sessionId || value === undefined) return;
  const map = store();
  const usage = resolveContextUsage(value as ContextUsage | null);
  map.delete(sessionId);
  if (!usage) return;
  map.set(sessionId, usage);
  if (map.size > MAX_SESSIONS) map.delete(map.keys().next().value!);
}

export function lastContextUsage(sessionId: string): ContextUsage | undefined {
  return store().get(sessionId);
}

export function forgetContextUsage(sessionId: string): void {
  store().delete(sessionId);
}
