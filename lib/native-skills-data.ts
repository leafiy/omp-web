import type { AgentEngine } from "./engine";
import { claudeSlashCommandRestriction } from "./claude-code-commands";
import type { NativeSkillItem, NativeSkillsReport } from "./native-skills-types";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, limit = 4000): string => typeof value === "string" ? value.slice(0, limit) : "";
const commandName = (value: string) => value.length > 0 && !/[\s/\\]/u.test(value);

/** Accept only explicit native metadata, never read skill/config/credential files. */
export function normalizeNativeSkills(engine: AgentEngine, cwd: string, raw: unknown): NativeSkillsReport {
  const report: NativeSkillsReport = { engine, cwd, status: "ok", items: [], note: "", checkedAt: new Date().toISOString() };
  if (engine === "codex") {
    const data = object(raw).data;
    if (!Array.isArray(data)) throw new Error("Invalid native skills catalog");
    const entry = data.map(object).find((row) => row.cwd === cwd);
    if (!entry || !Array.isArray(entry.skills) || !Array.isArray(entry.errors)) throw new Error("Missing project in native skills catalog");
    report.status = entry.errors.length ? "partial" : "ok";
    report.note = entry.errors.length ? "部分技能未能读取。详情请在原生 Codex 中检查。" : "由 Codex skills/list 返回；禁用状态以原生元数据为准。";
    report.items = entry.skills.map((raw): NativeSkillItem => {
      const row = object(raw);
      return { name: text(row.name, 256), description: text(row.description), kind: "skill", invocation: null, path: text(row.path) || null, enabled: typeof row.enabled === "boolean" ? row.enabled : null };
    });
  } else {
    const commands = object(raw).commands;
    if (!Array.isArray(commands)) throw new Error("Invalid native command catalog");
    const rows = commands.map(object);
    const builtinNames = new Set(rows.filter((row) => row.builtin === true).map((row) => row.name));
    report.items = rows.filter((row) => engine === "claude"
      ? row.builtin !== true && !builtinNames.has(row.name)
      : row.source === "skill").map((row): NativeSkillItem => {
      const name = text(row.name, 256);
      return {
        name, description: text(row.description), kind: engine === "claude" ? "command" : "skill",
        invocation: commandName(name) && (engine !== "claude" || !claudeSlashCommandRestriction(name)) ? `/${name}` : null,
        path: engine === "claude" ? null : text(object(row.sourceInfo).path) || null,
        enabled: null,
      };
    });
    report.note = engine === "claude"
      ? "CC 原生接口合并返回技能与自定义命令；已排除标记为内置的命令。路径和启用状态未由该接口提供。"
      : "仅展示原生命令目录中标记为 skill 的可调用技能。未公开、禁用或仅供模型使用的技能不一定出现在这里。";
  }
  const seen = new Set<string>();
  report.items = report.items.filter((item) => {
    if (!item.name) return false;
    const key = `${item.name}\0${item.path ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((a, b) => a.name.localeCompare(b.name));
  return report;
}
