import { AgentRpcClient } from "./agent-rpc-client";
import { ClaudeCodeSession } from "./claude-code-session";
import { CodexRpcClient, denyCodexRequest } from "./codex-rpc-client";
import { discoverAgent } from "./agent-executable";
import { normalizeNativeSkills } from "./native-skills-data";
import type { AgentEngine } from "./engine";
import type { NativeSkillsReport } from "./native-skills-types";

export interface NativeSkillReader { read(): Promise<unknown>; destroy(): void; }

function openReader(engine: AgentEngine, cwd: string): NativeSkillReader {
  if (engine === "claude") {
    const session = new ClaudeCodeSession({ cwd, catalogOnly: true }, () => {});
    return { read: async () => { await session.start(); return session.send({ type: "get_skill_commands" }); }, destroy: () => session.destroy() };
  }
  if (engine === "codex") {
    const client = new CodexRpcClient(cwd);
    client.onFrame((frame) => { if (frame.id !== undefined) denyCodexRequest(client, frame); });
    return { read: async () => { await client.start(); return client.request("skills/list", { cwds: [cwd], forceReload: false }); }, destroy: () => client.destroy() };
  }
  const client = new AgentRpcClient({ engine, cwd, catalogOnly: true });
  client.onFrame((frame) => {
    // A catalog reader has no interactive approval surface. Never approve hooks.
    if (frame.type === "extension_ui_request" && typeof frame.id === "string" && ["select", "confirm", "input", "editor"].includes(String(frame.method))) {
      client.write({ type: "extension_ui_response", id: frame.id, cancelled: true });
    }
  });
  return { read: async () => { await client.start(); return client.request({ type: engine === "omp" ? "get_available_commands" : "get_commands" }); }, destroy: () => client.destroy() };
}

type Entry = { startedAt: number; expiresAt: number; promise: Promise<NativeSkillsReport> };

/** Engine+project display cache. No live chat registry, prompts, threads or writes. */
export function createNativeSkillsService(options: {
  installed?: (engine: AgentEngine) => boolean;
  open?: (engine: AgentEngine, cwd: string) => NativeSkillReader;
  now?: () => number;
  timeoutMs?: number;
} = {}) {
  const installed = options.installed ?? ((engine) => discoverAgent(engine).installed);
  const open = options.open ?? openReader, now = options.now ?? Date.now;
  const cache = new Map<string, Entry>();
  let active = 0;
  const failure = (engine: AgentEngine, cwd: string, status: "error" | "unavailable", note: string): NativeSkillsReport => ({ engine, cwd, status, items: [], note, checkedAt: new Date(now()).toISOString() });
  return function getSkills(engine: AgentEngine, cwd: string, refresh = false): Promise<NativeSkillsReport> {
    const key = `${engine}\0${cwd}`, time = now(), previous = cache.get(key);
    if (previous && (previous.expiresAt === Infinity || time - previous.startedAt < 5000 || (!refresh && previous.expiresAt > time))) return previous.promise;
    if (!installed(engine)) return Promise.resolve(failure(engine, cwd, "unavailable", "这台机器未检测到所选 Agent；不会借用其他工具的技能。"));
    if (active >= 4) return Promise.resolve(failure(engine, cwd, "unavailable", "正在读取其他项目，请稍后刷新。"));
    const entry: Entry = { startedAt: time, expiresAt: Infinity, promise: Promise.resolve(failure(engine, cwd, "error", "读取失败。")) };
    active++;
    entry.promise = (async () => {
      let reader: NativeSkillReader | undefined, timer: ReturnType<typeof setTimeout> | undefined;
      try {
        reader = open(engine, cwd);
        const raw = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Native catalog timed out")), options.timeoutMs ?? 20_000); })]);
        const report = normalizeNativeSkills(engine, cwd, raw);
        entry.expiresAt = now() + 60_000;
        return report;
      } catch {
        entry.expiresAt = now() + 10_000;
        // Native diagnostics may contain private paths/configuration. Do not return them.
        return failure(engine, cwd, "error", "未能读取原生技能目录。请检查该 Agent 是否支持此接口及项目资源是否已获信任，然后刷新。没有把读取失败当成空目录。");
      } finally { clearTimeout(timer); reader?.destroy(); active--; }
    })();
    cache.set(key, entry);
    for (const [oldKey, old] of cache) {
      if (cache.size <= 32) break;
      if (old.expiresAt !== Infinity) cache.delete(oldKey);
    }
    return entry.promise;
  };
}

declare global { var __ompWebNativeSkills: ReturnType<typeof createNativeSkillsService> | undefined; }
export function getNativeSkills(engine: AgentEngine, cwd: string, refresh = false): Promise<NativeSkillsReport> {
  return (globalThis.__ompWebNativeSkills ??= createNativeSkillsService())(engine, cwd, refresh);
}
