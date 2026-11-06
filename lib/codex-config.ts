import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { getClaudeWebDir } from "./claude-code-config";
import { getAgentExecutable } from "./agent-executable";
import { nativeAgentEnvironment } from "./native-agent-environment";

export function getCodexExecutable(): string { return getAgentExecutable("codex"); }
export function getCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.OMP_WEB_CODEX_HOME || env.CODEX_HOME || join(homedir(), ".codex"));
}
export function getCodexWebDir(env: NodeJS.ProcessEnv = process.env): string {
  const directory = resolve(env.OMP_WEB_CODEX_STATE_DIR || join(homedir(), ".local", "state", "omp-web", "codex"));
  const canonical = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
  const others = [getCodexHome(env), getClaudeWebDir(env), env.OMP_CODING_AGENT_DIR || env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent"), env.OMP_WEB_PI_AGENT_DIR || join(homedir(), ".pi", "agent")];
  const sessions = canonical(join(directory, "sessions"));
  if (others.some((p) => {
    const other = canonical(join(p, "sessions"));
    return sessions === other || sessions.startsWith(other + sep) || other.startsWith(sessions + sep);
  })) throw new Error("Codex web history must use a separate directory from native/OMP/Pi/Claude history");
  return directory;
}

/** The CLI manages its own auth. Never open, copy or translate credential files. */
export function codexChildEnvironment(): NodeJS.ProcessEnv {
  const home = getCodexHome();
  const env = nativeAgentEnvironment();
  delete env.OMP_CODING_AGENT_DIR;
  delete env.PI_CODING_AGENT_DIR;
  delete env.PI_CODING_AGENT_SESSION_DIR;
  return { ...env, CODEX_HOME: home };
}

// The web host must not replace native feature, model or permission settings.
export const CODEX_ARGS = ["app-server", "--listen", "stdio://"];
