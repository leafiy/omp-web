import { homedir } from "node:os";
import { ClaudeCodeSession } from "./claude-code-session";
import { CodexRpcClient, denyCodexRequest } from "./codex-rpc-client";
import { discoverAgent } from "./agent-executable";
import { getRpcSession } from "./rpc-manager";
import { normalizeClaudeUsage, normalizeCodexUsage, normalizeSessionUsage, unavailableUsage } from "./usage-normalize";
import type { AgentUsage, UsageOverview } from "./usage-types";

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
  if (!session?.isAlive() || session.engine === "codex") return null;
  if (session.isRunning()) return unavailableUsage(session.engine, "当前会话运行中，结束后再读取原生 Token 统计。");
  try {
    if (session.engine === "claude") {
      const result = normalizeClaudeUsage(await bounded(session.send({ type: "get_native_usage" }), 8000), true);
      return { ...result, weekly: [], plan: null, note: "当前 Claude Code 会话累计，不是订阅账户总量。" };
    }
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
