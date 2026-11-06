import type { AgentEngine } from "./engine";

export interface WeeklyUsage {
  name: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
}
export interface AgentUsage {
  engine: AgentEngine;
  status: "ok" | "unavailable" | "error";
  plan: string | null;
  weekly: WeeklyUsage[];
  totalTokens: string | null;
  tokenScope: "account" | "session" | null;
  ordinaryUsageAllowed?: boolean | null;
  note: string;
  noteEn?: string;
  checkedAt: string;
}
export interface UsageOverview {
  subscriptions: AgentUsage[];
  session: AgentUsage | null;
  checkedAt: string;
}
