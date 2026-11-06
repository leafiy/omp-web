export type AgentEngine = "omp" | "pi" | "claude" | "codex";

export function engineLabel(engine: AgentEngine): string {
  return engine === "codex" ? "Codex CLI" : engine === "claude" ? "Claude Code" : engine === "pi" ? "Pi" : "OMP";
}

/** Older clients and existing unqualified session links keep using OMP. */
export function parseEngine(value: unknown): AgentEngine {
  if (value === undefined || value === null || value === "omp") return "omp";
  if (value === "pi" || value === "claude" || value === "codex") return value;
  throw new Error("Unknown agent engine; expected omp, pi, claude or codex");
}

/** Pi IDs are namespaced in the web API only; native JSONL files are unchanged. */
export function engineForSession(sessionId: string): AgentEngine {
  return sessionId.startsWith("codex:") ? "codex" : sessionId.startsWith("claude:") ? "claude" : sessionId.startsWith("pi:") ? "pi" : "omp";
}

export function nativeSessionId(sessionId: string): string {
  const engine = engineForSession(sessionId);
  return engine === "omp" ? sessionId : sessionId.slice(engine.length + 1);
}

export function sessionKey(engine: AgentEngine, nativeId: string): string {
  return engine === "omp" ? nativeId : `${engine}:${nativeId}`;
}

/** Initial CC/Codex adapters expose basic chat, not OMP/Pi's extended controls. */
export function supportsExtendedChat(engine: AgentEngine): boolean { return engine === "omp" || engine === "pi"; }
