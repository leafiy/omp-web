import { homedir } from "node:os";
import { ClaudeCodeSession } from "./claude-code-session";
import { CodexRpcClient, denyCodexRequest } from "./codex-rpc-client";
import { discoverAgent } from "./agent-executable";
import { getRpcSession } from "./rpc-manager";
import { localTokenSnapshot, LOCAL_TOKEN_RETENTION_MS, type LocalTokenSnapshot, type TokenParts } from "./local-token-usage";
import { normalizeClaudeUsage, normalizeCodexUsage, normalizeSessionUsage, unavailableUsage } from "./usage-normalize";
import type { AgentUsage, PeriodTokens, TokenPeriodRow, TokenPeriods, UsageOverview } from "./usage-types";

async function bounded<T>(work: Promise<T>, milliseconds = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Usage metadata timeout")), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

async function claudeUsage(): Promise<AgentUsage> {
  if (!discoverAgent("claude").installed) return unavailableUsage("claude", "这台机器未检测到 Claude Code。");
  const session = new ClaudeCodeSession({ cwd: homedir(), catalogOnly: true }, () => {});
  try {
    return await bounded((async () => {
      await session.start();
      const raw = await session.send({ type: "get_native_usage" });
      return normalizeClaudeUsage(raw, false);
    })());
  } catch {
    return unavailableUsage("claude", "暂时无法读取。请在 Claude Code 中检查登录和用量。", "error");
  } finally { session.destroy(); }
}

async function codexUsage(): Promise<AgentUsage> {
  if (!discoverAgent("codex").installed) return unavailableUsage("codex", "这台机器未检测到 Codex CLI。");
  const client = new CodexRpcClient(homedir());
  client.onFrame((frame) => { if (frame.id !== undefined) denyCodexRequest(client, frame); });
  try {
    return await bounded((async () => {
      await client.start();
      const account = await client.request("account/read", { refreshToken: false });
      const a = account.account as { type?: string } | null;
      if (a?.type !== "chatgpt") return normalizeCodexUsage(account, null, null);
      // No thread creation, user prompt, token extraction, or direct provider API call.
      const [limits, usage] = await Promise.allSettled([
        client.request("account/rateLimits/read", {}),
        client.request("account/usage/read", {}),
      ]);
      const result = normalizeCodexUsage(account, limits.status === "fulfilled" ? limits.value : null, usage.status === "fulfilled" ? usage.value : null);
      if (limits.status === "rejected" || usage.status === "rejected") result.note += " 部分统计未由原生接口返回。";
      return result;
    })());
  } catch {
    return unavailableUsage("codex", "暂时无法读取。请在 Codex CLI 中检查登录和用量。", "error");
  } finally { client.destroy(); }
}

async function sessionUsage(sessionId?: string): Promise<AgentUsage | null> {
  const session = sessionId ? getRpcSession(sessionId) : undefined;
  // Claude Code and Codex show only their subscription cards; no separate current-session card.
  if (!session?.isAlive() || session.engine === "codex" || session.engine === "claude") return null;
  if (session.isRunning()) return unavailableUsage(session.engine, "当前会话运行中，结束后再读取原生 Token 统计。");
  try {
    return normalizeSessionUsage(session.engine, await bounded(session.send({ type: "get_session_stats" }), 8000));
  }
  catch { return unavailableUsage(session.engine, "未能读取当前原生会话的 Token 统计。", "error"); }
}

type Entry = { startedAt: number; expiresAt: number; promise: Promise<UsageOverview> };
declare global {
  var __ompWebUsageCache: Map<string, Entry> | undefined;
  var __ompWebSubscriptions: { startedAt: number; expiresAt: number; promise: Promise<AgentUsage[]> } | undefined;
}
function subscriptions(refresh: boolean): Promise<AgentUsage[]> {
  const previous = globalThis.__ompWebSubscriptions, now = Date.now();
  if (previous && (previous.expiresAt === Infinity || now - previous.startedAt < 5000 || (!refresh && previous.expiresAt > now))) return previous.promise;
  const entry = { startedAt: now, expiresAt: Infinity, promise: Promise.resolve<AgentUsage[]>([]) };
  entry.promise = Promise.all([claudeUsage(), codexUsage()]).then((reports) => {
    entry.expiresAt = Date.now() + (reports.some((r) => r.status === "error") ? 10_000 : 60_000);
    return reports;
  }).catch(() => {
    entry.expiresAt = Date.now() + 10_000;
    return [unavailableUsage("claude", "读取用量失败。", "error"), unavailableUsage("codex", "读取用量失败。", "error")];
  });
  globalThis.__ompWebSubscriptions = entry;
  return entry.promise;
}

/** A short in-memory display cache, not an account/credential store. */
export function getSubscriptionUsage(sessionId?: string, refresh = false): Promise<UsageOverview> {
  if (sessionId && !getRpcSession(sessionId)?.isAlive()) sessionId = undefined;
  const cache = globalThis.__ompWebUsageCache ??= new Map();
  const key = sessionId || "overview", now = Date.now(), previous = cache.get(key);
  if (previous && (previous.expiresAt === Infinity || now - previous.startedAt < 5000 || (!refresh && previous.expiresAt > now))) return previous.promise;
  const entry: Entry = { startedAt: now, expiresAt: Infinity, promise: Promise.resolve({ subscriptions: [], session: null, checkedAt: "" }) };
  entry.promise = Promise.all([subscriptions(refresh), sessionUsage(sessionId)]).then(([reports, session]) => {
    entry.expiresAt = Date.now() + 60_000;
    return { subscriptions: reports, session, checkedAt: new Date().toISOString() };
  }).catch(() => {
    entry.expiresAt = Date.now() + 10_000;
    return { subscriptions: [unavailableUsage("claude", "读取用量失败。", "error"), unavailableUsage("codex", "读取用量失败。", "error")], session: null, checkedAt: new Date().toISOString() };
  });
  cache.set(key, entry);
  while (cache.size > 16) cache.delete(cache.keys().next().value!);
  return entry.promise;
}

/** Browser-local period starts: today, this week (Monday) and this month, as instants and calendar dates. */
export interface PeriodQuery { starts: [number, number, number]; dates: [string, string, string] }
const DAY_MS = 24 * 60 * 60 * 1000;

export function parsePeriodQuery(since: string | null, dates: string | null, now = Date.now()): PeriodQuery | null {
  const starts = (since ?? "").split(",").map((value) => /^\d{1,16}$/.test(value) ? Number(value) : NaN), days = (dates ?? "").split(",");
  if (starts.length !== 3 || days.length !== 3) return null;
  // A month start is at most 31 days plus a time-zone offset ago; the local summary keeps 40 days.
  if (!starts.every((start) => Number.isSafeInteger(start) && start > now - LOCAL_TOKEN_RETENTION_MS + DAY_MS && start <= now + DAY_MS)) return null;
  if (!days.every((day) => /^\d{4}-\d{2}-\d{2}$/.test(day))) return null;
  return { starts: starts as PeriodQuery["starts"], dates: days as PeriodQuery["dates"] };
}

function localPeriod(parts: TokenParts): PeriodTokens {
  const [input, output, cacheRead, cacheWrite] = parts;
  return { total: String(input + output + cacheRead + cacheWrite), input: String(input), output: String(output), cacheRead: String(cacheRead), cacheWrite: String(cacheWrite) };
}

function codexPeriods(report: AgentUsage | undefined, dates: PeriodQuery["dates"]): TokenPeriodRow {
  const daily = report?.dailyTokens;
  if (!daily) return { engine: "codex", scope: "account", status: "unavailable", day: null, week: null, month: null };
  // Codex dates are its own calendar days; they are compared with the browser's local dates as-is.
  const [day, week, month] = dates.map((start): PeriodTokens => ({
    total: daily.filter((bucket) => bucket.date >= start).reduce((sum, bucket) => sum + BigInt(bucket.tokens), BigInt(0)).toString(),
  }));
  const earliest = daily[0]?.date, oldest = [...dates].sort()[0];
  return { engine: "codex", scope: "account", status: "ok", day, week, month, dataFrom: earliest && earliest > oldest ? earliest : null };
}

/** Pure: Codex native daily buckets plus this machine's summed session records, in a fixed row order. */
export function buildTokenPeriods(subscriptions: AgentUsage[], local: LocalTokenSnapshot, query: PeriodQuery): TokenPeriods {
  const rows: TokenPeriodRow[] = [];
  for (const engine of ["claude", "codex", "omp", "pi"] as const) {
    if (engine === "codex") { rows.push(codexPeriods(subscriptions.find((report) => report.engine === "codex"), query.dates)); continue; }
    const row = local.rows.find((item) => item.engine === engine);
    if (!row) continue;
    if (!row.complete) { rows.push({ engine, scope: "local", status: "pending", day: null, week: null, month: null }); continue; }
    const [day, week, month] = row.periods.map(localPeriod);
    rows.push({ engine, scope: "local", status: "ok", day, week, month });
  }
  return { rows, pending: local.pending, scannedAt: local.scannedAt };
}

function publicReport(report: AgentUsage): AgentUsage {
  const { dailyTokens, ...rest } = report;
  void dailyTokens;
  return rest;
}

/** Subscription/session cards (cached) plus, when requested, day/week/month token totals (computed per request). */
export async function getUsageOverview(sessionId: string | undefined, refresh: boolean, query: PeriodQuery | null): Promise<UsageOverview> {
  const [overview, local] = await Promise.all([
    getSubscriptionUsage(sessionId, refresh),
    query ? localTokenSnapshot(query.starts, refresh) : Promise.resolve(null),
  ]);
  const result: UsageOverview = { ...overview, subscriptions: overview.subscriptions.map(publicReport) };
  if (query && local) result.tokens = buildTokenPeriods(overview.subscriptions, local, query);
  return result;
}
