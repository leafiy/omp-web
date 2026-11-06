import type { AgentEngine } from "./engine";
import type { AgentUsage, WeeklyUsage } from "./usage-types";

function obj(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function tokenCount(value: unknown): string | null {
  if (typeof value === "bigint") return value >= BigInt(0) && value.toString().length <= 30 ? value.toString() : null;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value === "string" && /^\d{1,30}$/.test(value)) return BigInt(value).toString();
  return null;
}
function date(value: unknown, seconds = false): string | null {
  if (seconds ? typeof value !== "number" : typeof value !== "string") return null;
  const ms = seconds ? (value as number) * 1000 : Date.parse(value as string);
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  return new Date(ms).toISOString();
}
function window(name: string, used: unknown, reset: unknown, seconds = false): WeeklyUsage | null {
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return null;
  return { name: name.slice(0, 100), usedPercent: used, remainingPercent: Math.max(0, Math.min(100, 100 - used)), resetsAt: date(reset, seconds) };
}
export function unavailableUsage(engine: AgentEngine, note: string, status: AgentUsage["status"] = "unavailable"): AgentUsage {
  return { engine, status, plan: null, weekly: [], totalTokens: null, tokenScope: null, note, noteEn: "Native usage data is unavailable. Check the tool's login and supported interfaces.", checkedAt: new Date().toISOString() };
}

/** No quota-to-token conversion; no fresh metadata session's zero masquerading as a lifetime total. */
export function normalizeClaudeUsage(raw: unknown, actualSession: boolean): AgentUsage {
  const data = obj(raw), limits = obj(data.rate_limits_available === false ? null : data.rate_limits), weekly: WeeklyUsage[] = [];
  if (Array.isArray(limits.limits)) {
    for (const value of limits.limits) {
      const row = obj(value);
      if (row.group !== "weekly" || !String(row.kind).startsWith("weekly")) continue;
      const scope = obj(row.scope);
      const name = row.kind === "weekly_all" ? "全部模型" : String(obj(scope.model).display_name || obj(scope.surface).display_name || "周额度");
      const normalized = window(name, row.percent, row.resets_at); if (normalized) weekly.push(normalized);
    }
  } else {
    for (const [key, label] of [["seven_day", "全部模型"], ["seven_day_oauth_apps", "OAuth 应用"]]) {
      const row = obj(limits[key]), value = window(label, row.utilization, row.resets_at); if (value) weekly.push(value);
    }
    if (Array.isArray(limits.model_scoped) && limits.model_scoped.length) {
      for (const value of limits.model_scoped) {
        const row = obj(value), normalized = window(String(row.display_name || "模型周额度"), row.utilization, row.resets_at);
        if (normalized) weekly.push(normalized);
      }
    } else for (const [key, label] of [["seven_day_opus", "Opus"], ["seven_day_sonnet", "Sonnet"]]) {
      const row = obj(limits[key]), value = window(label, row.utilization, row.resets_at); if (value) weekly.push(value);
    }
  }
  let totalTokens: string | null = null;
  if (actualSession && obj(data.session).model_usage && typeof obj(data.session).model_usage === "object") {
    let total = BigInt(0), valid = true;
    for (const value of Object.values(obj(obj(data.session).model_usage))) {
      const usage = obj(value);
      for (const key of ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"]) {
        const n = tokenCount(usage[key]); if (n === null) valid = false; else total += BigInt(n);
      }
    }
    if (valid) totalTokens = total.toString();
  }
  return { engine: "claude", status: weekly.length || totalTokens !== null ? "ok" : "unavailable",
    plan: typeof data.subscription_type === "string" ? data.subscription_type.slice(0, 80) : null, weekly, totalTokens,
    tokenScope: totalTokens === null ? null : "session",
    note: actualSession ? "Token 是当前 Claude Code 会话累计，不是订阅账户累计。" : "Claude 这里不提供账号累计 Token，会话统计会单独显示。",
    noteEn: actualSession ? "Current Claude Code session tokens, not an account lifetime total." : "Claude provides no account lifetime token total here. An empty metadata session is not reported as zero account usage.",
    checkedAt: new Date().toISOString() };
}

export function normalizeCodexUsage(accountRaw: unknown, limitsRaw: unknown, usageRaw: unknown): AgentUsage {
  const account = obj(obj(accountRaw).account), limits = obj(limitsRaw), byId = obj(limits.rateLimitsByLimitId);
  const buckets = Object.keys(byId).length ? Object.values(byId) : limits.rateLimits ? [limits.rateLimits] : [];
  const weekly: WeeklyUsage[] = [];
  for (const value of buckets) {
    const bucket = obj(value);
    for (const key of ["primary", "secondary"]) {
      const row = obj(bucket[key]);
      if (row.windowDurationMins !== 7 * 24 * 60) continue;
      const w = window(String(bucket.limitName || bucket.limitId || "Codex"), row.usedPercent, row.resetsAt, true);
      if (w) weekly.push(w);
    }
  }
  const totalTokens = tokenCount(obj(obj(usageRaw).summary).lifetimeTokens);
  const plan = account.type === "chatgpt" && typeof account.planType === "string" ? account.planType.slice(0, 80) : null;
  return { engine: "codex", status: weekly.length || totalTokens !== null ? "ok" : "unavailable", plan, weekly, totalTokens,
    tokenScope: totalTokens === null ? null : "account", ordinaryUsageAllowed: typeof limits.ordinaryUsageAllowed === "boolean" ? limits.ordinaryUsageAllowed : null,
    note: account.type === "chatgpt" ? "账号累计，来自 Codex；周额度和短周期额度分别计算。" : "当前 Codex 未提供 ChatGPT 订阅信息，可能未登录或使用 API/其他提供方。",
    noteEn: account.type === "chatgpt" ? "Lifetime tokens reported by Codex. Weekly quota does not imply short-window availability." : "No ChatGPT subscription information was provided. The CLI may be signed out or using an API/cloud provider.",
    checkedAt: new Date().toISOString() };
}

export function normalizeSessionUsage(engine: AgentEngine, raw: unknown): AgentUsage {
  const totalTokens = tokenCount(obj(obj(raw).tokens).total);
  return { ...unavailableUsage(engine, "只统计当前原生会话，不是账户累计；OMP/Pi RPC 未提供订阅周额度。"), status: totalTokens === null ? "unavailable" : "ok", totalTokens, tokenScope: totalTokens === null ? null : "session", noteEn: "Current native session only, not an account lifetime total. OMP/Pi RPC provides no subscription weekly quota." };
}
