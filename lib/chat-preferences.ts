import type { AgentEngine } from "./engine";

export type PreferredModel = { provider: string; modelId: string };
const key = (cwd: string) => `omp-web:chat-preferences:${cwd}`;
type Preferences = { engine?: AgentEngine; models?: Partial<Record<AgentEngine, PreferredModel>> };

function read(cwd: string): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(key(cwd)) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function preferredEngine(cwd: string): AgentEngine | undefined {
  const engine = read(cwd).engine;
  return engine === "omp" || engine === "pi" || engine === "claude" || engine === "codex" ? engine : undefined;
}

export function preferredModel(cwd: string, engine: AgentEngine): PreferredModel | null {
  const model = read(cwd).models?.[engine];
  return model && typeof model.provider === "string" && model.provider && typeof model.modelId === "string" && model.modelId
    ? { provider: model.provider, modelId: model.modelId } : null;
}

export function rememberChatChoice(cwd: string, engine: AgentEngine, model?: PreferredModel): void {
  if (!cwd) return;
  try {
    const previous = read(cwd);
    localStorage.setItem(key(cwd), JSON.stringify({
      ...previous, engine,
      ...(model ? { models: { ...previous.models, [engine]: model } } : {}),
    }));
  } catch { /* Preferences are optional when browser storage is unavailable. */ }
}
