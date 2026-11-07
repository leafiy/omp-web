export type AgentTaskStatus = "running" | "completed" | "failed" | "stopped" | "unknown";
export interface AgentTask {
  id: string;
  runId?: string;
  parentId?: string;
  title: string;
  kind: string;
  status: AgentTaskStatus;
  active: boolean;
  ambient?: boolean;
  hidden?: boolean;
  detail?: string;
  updatedAt: number;
}
export interface AgentTaskSnapshot {
  epoch: string;
  revision: number;
  coverage: "native" | "partial" | "unavailable";
  tasks: AgentTask[];
}
export interface AgentTaskMessage {
  role: "user" | "assistant" | "tool";
  text: string;
}
export interface AgentTaskTranscript {
  messages: AgentTaskMessage[];
  truncated: boolean;
}
export interface AgentTaskDetail extends AgentTaskTranscript {
  task: AgentTask;
  available: boolean;
}

export function hasActiveTasks(snapshot?: AgentTaskSnapshot | null): boolean {
  return Boolean(snapshot?.tasks.some(task => task.active && !task.ambient));
}
export function hasUnknownTasks(snapshot?: AgentTaskSnapshot | null): boolean {
  return Boolean(snapshot?.tasks.some(task => task.status === "unknown" && !task.hidden && !task.ambient));
}
