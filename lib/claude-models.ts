import type { ModelInfo, Query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelsData } from "./models-cache";

export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = typeof CLAUDE_EFFORT_LEVELS[number];
export interface ClaudeModelSettings { model: string; effort: ClaudeEffort | null }
export function isClaudeEffort(value: unknown): value is ClaudeEffort {
  return typeof value === "string" && (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(value);
}

// The pinned SDK has these native control requests at runtime but does not
// expose typed convenience methods. Only these two read-only requests cross
// this seam; raw settings (including environment credentials) never leave it.
type CatalogQuery = Pick<Query, "supportedModels"> & {
  request?: (request: { subtype: "list_models" | "get_settings" }) => Promise<{ response?: unknown }>;
};
function unsupported(error: unknown): boolean {
  return error instanceof Error && /(?:unknown|unsupported|unrecognized|not supported).*(?:request|subtype)|(?:request|subtype).*(?:unknown|unsupported|unrecognized|not supported)/i.test(error.message);
}
async function control(query: Query, subtype: "list_models" | "get_settings"): Promise<unknown> {
  const runtime = query as unknown as CatalogQuery;
  if (!runtime.request) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      runtime.request({ subtype }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Claude ${subtype} timed out`)), 15_000); }),
    ]);
    return result.response;
  } catch (error) {
    if (unsupported(error)) return undefined;
    throw error;
  } finally { clearTimeout(timer); }
}

export async function readClaudeModels(query: Query): Promise<ModelInfo[]> {
  const response = await control(query, "list_models") as { models?: ModelInfo[] } | undefined;
  if (response === undefined) return query.supportedModels();
  if (!Array.isArray(response.models) || response.models.some(m => typeof m?.value !== "string" || !m.value)) {
    throw new Error("Claude returned an invalid model catalog");
  }
  return response.models;
}

export async function readClaudeModelSettings(query: Query): Promise<ClaudeModelSettings | undefined> {
  const response = await control(query, "get_settings") as { applied?: { model?: unknown; effort?: unknown } } | undefined;
  if (response === undefined) return undefined;
  const applied = response.applied;
  if (!applied || typeof applied.model !== "string" || !applied.model) throw new Error("Claude did not report its applied model");
  return { model: applied.model, effort: isClaudeEffort(applied.effort) ? applied.effort : null };
}

export function claudeEffortLevels(models: ModelInfo[], model: string): ClaudeEffort[] {
  const row = models.find(m => m.value === model) ?? models.find(m => m.resolvedModel === model);
  return row?.supportsEffort === true ? [...new Set((row.supportedEffortLevels ?? []).filter(isClaudeEffort))] : [];
}

export function claudeModelsData(models: ModelInfo[], settings: ClaudeModelSettings | undefined, effortControlAvailable: boolean): ModelsData {
  const modelList = models.map(m => ({ id: m.value, provider: "claude-code", name: m.displayName || m.value, resolvedModel: m.resolvedModel, description: m.description }));
  // An explicit custom model can be active without being in the CLI menu. Show
  // the actual selection; do not fabricate effort capabilities or other models.
  if (settings && !modelList.some(m => m.id === settings.model || m.resolvedModel === settings.model)) {
    modelList.push({ id: settings.model, provider: "claude-code", name: settings.model, resolvedModel: settings.model, description: "Current native model" });
  }
  const names: Record<string, string> = {}, thinkingLevels: Record<string, string[]> = {};
  // Prefer concrete rows over the generic 'Default' label for resolved IDs.
  for (const m of modelList) {
    names[`claude-code:${m.id}`] = m.name;
    const levels = claudeEffortLevels(models, m.id);
    thinkingLevels[`claude-code:${m.id}`] = levels;
    if (m.resolvedModel) {
      names[`claude-code:${m.resolvedModel}`] = m.name;
      thinkingLevels[`claude-code:${m.resolvedModel}`] = levels;
    }
  }
  return {
    modelList, models: names, defaultModel: settings ? { provider: "claude-code", modelId: settings.model } : null,
    thinkingLevels, thinkingLevelMaps: {}, thinkingLevelPins: {},
    defaultThinkingLevel: settings?.effort ?? "auto", effortControlAvailable,
  };
}
