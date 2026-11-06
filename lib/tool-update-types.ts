export const TOOL_IDS = ["pi", "omp", "claude", "codex"] as const;
export type UpdatableTool = typeof TOOL_IDS[number];
export const TOOL_LABELS: Record<UpdatableTool, string> = {
  pi: "Pi", omp: "OMP", claude: "Claude Code (CC)", codex: "Codex",
};
export type ToolUpdatePhase = "idle" | "updating" | "restarting" | "succeeded" | "failed";

export interface ToolUpdateStatus {
  tool: UpdatableTool;
  available: boolean;
  unavailableReason?: string;
  executable?: string;
  installedVersion?: string;
  versionError?: string;
  phase: ToolUpdatePhase;
  id?: string;
  previousVersion?: string;
  currentVersion?: string;
  startedAt?: string;
  finishedAt?: string;
  output: string;
  error?: string;
}

export interface ToolUpdatesSnapshot {
  tools: ToolUpdateStatus[];
  job: ToolUpdateStatus | null;
}

export function isUpdatableTool(value: unknown): value is UpdatableTool {
  return typeof value === "string" && (TOOL_IDS as readonly string[]).includes(value);
}

/** Fixed target + explicit confirmation only. Never accept commands or paths. */
export function parseToolUpdateRequest(body: unknown): UpdatableTool {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected {tool, confirm:true}");
  const value = body as Record<string, unknown>;
  if (value.confirm !== true || !isUpdatableTool(value.tool)
    || Object.keys(value).length !== 2) throw new Error("Expected {tool, confirm:true}; commands and paths are not accepted");
  return value.tool;
}
