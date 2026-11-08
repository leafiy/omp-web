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
  /** Server-side only (stripped before responding): Codex native account daily buckets. */
  dailyTokens?: DailyTokens[] | null;
  note: string;
  noteEn?: string;
  checkedAt: string;
}
export interface DailyTokens { date: string; tokens: string }
/** Decimal strings. Parts are present only where the source records them. */
export interface PeriodTokens { total: string; input?: string; output?: string; cacheRead?: string; cacheWrite?: string }
export interface TokenPeriodRow {
  engine: AgentEngine;
  /** account: the native service's own account-wide numbers; local: this machine's native session records. */
  scope: "account" | "local";
  status: "ok" | "pending" | "unavailable";
  day: PeriodTokens | null;
  week: PeriodTokens | null;
  month: PeriodTokens | null;
  /** Earliest native daily bucket, when it is later than the oldest requested period start. */
  dataFrom?: string | null;
}
export interface TokenPeriods { rows: TokenPeriodRow[]; pending: boolean; scannedAt: string | null }
export interface UsageOverview {
  subscriptions: AgentUsage[];
  session: AgentUsage | null;
  /** Today / this week (Monday) / this month in the browser's local time; absent unless requested. */
  tokens?: TokenPeriods | null;
  checkedAt: string;
}
