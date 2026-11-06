import { accessSync, constants, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { AgentEngine } from "./engine";

const names: Record<AgentEngine, string> = { omp: "omp", pi: "pi", claude: "claude", codex: "codex" };
const overrides: Record<AgentEngine, string> = { omp: "OMP_WEB_EXECUTABLE", pi: "OMP_WEB_PI_EXECUTABLE", claude: "OMP_WEB_CC_EXECUTABLE", codex: "OMP_WEB_CODEX_EXECUTABLE" };
type DiscoveryOptions = { env?: NodeJS.ProcessEnv; home?: string; appRoot?: string; nodePath?: string; systemDirs?: string[] };
export interface AgentInstallation {
  engine: AgentEngine;
  installed: boolean;
  executable?: string;
  candidates: string[];
  configured: boolean;
  error?: string;
}

/** No login shell, program execution, downloads, or credential/config reads. */
export function discoverAgent(engine: AgentEngine, options: DiscoveryOptions = {}): AgentInstallation {
  const env = options.env ?? process.env, home = options.home ?? homedir();
  const appRoot = resolve(options.appRoot ?? env.OMP_WEB_APP_DIR ?? process.cwd());
  const canonical = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const bundled = canonical(join(appRoot, "node_modules"));
  const allowed = (p: string) => {
    try {
      accessSync(p, constants.X_OK);
      const actual = canonical(p);
      return statSync(p).isFile() && actual !== bundled && !actual.startsWith(bundled + sep);
    } catch { return false; }
  };
  const pathDirs = (env.PATH || "").split(delimiter).filter((p) => isAbsolute(p));
  const common = [join(home, ".local", "bin"), join(home, ".bun", "bin"), join(home, ".npm-global", "bin"), join(home, ".local", "share", "pnpm"),
    env.NVM_BIN, env.PNPM_HOME, env.BUN_INSTALL && join(env.BUN_INSTALL, "bin"), dirname(options.nodePath ?? process.execPath), ...(options.systemDirs ?? ["/usr/local/bin", "/usr/bin", "/opt/homebrew/bin"])]
    .filter((p): p is string => Boolean(p && isAbsolute(p)));
  // NVM/fnm installations are often absent from a systemd service's PATH.
  for (const [root, suffix] of [[join(home, ".nvm", "versions", "node"), "bin"], [join(home, ".local", "share", "fnm", "node-versions"), "installation/bin"]]) {
    try {
      for (const version of readdirSync(root).filter((n) => /^v?\d+\.\d+\.\d+$/.test(n)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) common.push(join(root, version, suffix));
    } catch { /* Optional manager. */ }
  }
  const configured = env[overrides[engine]];
  const dirs = [...new Set([...pathDirs, ...common])];
  const targets = configured
    ? (isAbsolute(configured) || configured.includes("/") ? [resolve(configured)] : dirs.map((d) => join(d, configured)))
    : dirs.map((d) => join(d, names[engine]));
  const candidates = [...new Set(targets)].filter(allowed);
  return { engine, installed: candidates.length > 0, executable: candidates[0], candidates, configured: Boolean(configured),
    ...(candidates.length ? {} : { error: configured ? `Configured ${names[engine]} executable is unavailable; no fallback was used.` : `${names[engine]} was not found in PATH or the user's installation directories.` }) };
}

export function getAgentExecutable(engine: AgentEngine, env: NodeJS.ProcessEnv = process.env): string {
  const result = discoverAgent(engine, { env });
  if (result.executable) return result.executable;
  // Preserve an explicit selection verbatim: spawning it fails rather than
  // silently switching installations. This also permits custom launchers.
  if (env[overrides[engine]]) return env[overrides[engine]]!;
  throw new Error(result.error);
}
