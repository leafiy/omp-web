import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { getOmpExecutable, getPiExecutable } from "./agent-rpc-client";
import { getOmpAgentDir } from "./file-paths";
import { getPiAgentDir } from "./engine-paths";
import { getAgentExecutable } from "./agent-executable";
import { getCodexExecutable, getCodexHome } from "./codex-config";
import type { UpdatableTool } from "./tool-update-types";

export interface ToolUpdatePlan {
  tool: UpdatableTool;
  executable: string;
  command: string;
  args: string[];
  installedVersion?: string;
}

function findExecutable(value: string, searchPath: string): string {
  const candidates = isAbsolute(value) || value.includes("/")
    ? [resolve(value)]
    : searchPath.split(delimiter).filter(Boolean).map((p) => resolve(p, value));
  const found = candidates.find((p) => {
    try { accessSync(p, constants.X_OK); return statSync(p).isFile(); } catch { return false; }
  });
  if (!found) throw new Error("Software was not found at its configured executable path.");
  return found;
}

/** Inspect installation metadata only. Never run an executable or contact a registry. */
export function planToolUpdate(tool: UpdatableTool, configured: string, home = homedir(), searchPath = process.env.PATH || ""): ToolUpdatePlan {
  const executable = findExecutable(configured, searchPath);
  const expectedName = tool === "claude" ? "claude" : tool;
  if (basename(executable) !== expectedName) throw new Error(`The configured executable must be named ${expectedName}.`);
  if (tool === "omp") return { tool, executable, command: executable, args: ["update"] };
  const actual = realpathSync(executable);
  if (tool === "claude") {
    // The native updater owns this launcher, not arbitrary pinned binaries or wrappers.
    const launcher = join(home, ".local", "bin", "claude");
    const versions = join(home, ".local", "share", "claude", "versions");
    if (executable !== launcher || dirname(actual) !== realpathSync(versions)
      || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(basename(actual))) {
      throw new Error("Web updates support the native ~/.local/bin/claude installation. Update other installations in a terminal.");
    }
    return { tool, executable, command: executable, args: ["update"], installedVersion: basename(actual) };
  }

  if (tool === "pi" && actual === join(home, ".pi", "agent", "bin", "pi")) {
    return { tool, executable, command: executable, args: ["update", "self"] };
  }
  const standalone = join(home, ".codex", "packages", "standalone", "releases");
  if (tool === "codex" && actual.startsWith(standalone + "/") && actual.endsWith("/bin/codex")) {
    const version = actual.slice(standalone.length + 1).split("/")[0].match(/^(\d+\.\d+\.\d+)(?:-|$)/)?.[1];
    return { tool, executable, command: executable, args: ["update"], installedVersion: version };
  }

  // Do not update whichever npm prefix happens to be the default. Trace the
  // actual selected CLI (including symlink chains) to its global package/bin.
  const packageName = tool === "pi" ? "@earendil-works/pi-coding-agent" : "@openai/codex";
  for (let directory = dirname(actual); dirname(directory) !== directory; directory = dirname(directory)) {
    const marker = `${join("lib", "node_modules", packageName)}`;
    if (!directory.endsWith(`/${marker}`)) continue;
    const prefix = directory.slice(0, -(marker.length + 1));
    const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { name?: string; version?: string; bin?: Record<string, string> };
    if (pkg.name !== packageName || typeof pkg.bin?.[tool] !== "string"
      || realpathSync(join(directory, pkg.bin[tool])) !== actual
      || realpathSync(join(prefix, "bin", tool)) !== actual) break;
    return {
      tool, executable, command: findExecutable("npm", searchPath),
      args: ["install", "--global", "--prefix", prefix, "--ignore-scripts", "--include=optional", "--no-audit", "--no-fund", `${packageName}@latest`],
      installedVersion: pkg.version,
    };
  }
  throw new Error("Web updates support this tool's official global npm installation. Update other installations in a terminal.");
}

export function resolveToolUpdatePlan(tool: UpdatableTool): ToolUpdatePlan {
  const configured = tool === "omp" ? getOmpExecutable()
    : tool === "pi" ? getPiExecutable()
    : tool === "claude" ? getAgentExecutable("claude")
    : getCodexExecutable();
  return planToolUpdate(tool, configured);
}

export function updateEnvironment(plan: ToolUpdatePlan): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // No chat identity, web password or inherited model credentials in updaters.
  for (const name of Object.keys(env)) {
    if (/^(ANTHROPIC_|OPENAI_|CLAUDE_|CLAUDECODE$|CODEX_|OMP_|PI_)/.test(name)) delete env[name];
  }
  env.PATH = `${dirname(plan.executable)}${delimiter}${process.env.PATH || ""}`;
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  if (plan.tool === "omp") {
    env.OMP_CODING_AGENT_DIR = getOmpAgentDir();
    env.PI_CODING_AGENT_DIR = env.OMP_CODING_AGENT_DIR;
  } else if (plan.tool === "pi") {
    env.PI_CODING_AGENT_DIR = getPiAgentDir();
  } else if (plan.tool === "claude") {
    if (process.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
  } else if (plan.tool === "codex") {
    env.CODEX_HOME = getCodexHome();
  }
  return env;
}

export function validToolVersion(tool: UpdatableTool, version: string): boolean {
  const semver = "\\d+\\.\\d+\\.\\d+(?:[-+][A-Za-z0-9.-]+)?";
  const pattern = tool === "omp" ? `omp/${semver}` : tool === "claude" ? `${semver} \\(Claude Code\\)`
    : tool === "codex" ? `codex-cli ${semver}` : semver;
  return new RegExp(`^${pattern}$`).test(version);
}
