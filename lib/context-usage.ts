import type { ContextUsage } from "./pi-types";

function capacity(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function amount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Native context is authoritative, including configured windows smaller than the catalog. */
export function resolveContextUsage(native: ContextUsage | null | undefined, catalogWindow?: number): ContextUsage | undefined {
  if (native && capacity(native.contextWindow)) {
    return { contextWindow: native.contextWindow, tokens: amount(native.tokens), percent: amount(native.percent) };
  }
  return capacity(catalogWindow) ? { contextWindow: catalogWindow, tokens: null, percent: null } : undefined;
}

/** SDK summary only; never return memory paths, tools, agents, or other private metadata. */
export function claudeContextUsage(raw: unknown): ContextUsage | null {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  if (!capacity(value.maxTokens)) return null;
  return { contextWindow: value.maxTokens, tokens: amount(value.totalTokens), percent: amount(value.percentage) };
}
