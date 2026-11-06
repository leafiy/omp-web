import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { getAgentExecutable } from "./agent-executable";
import { nativeAgentEnvironment } from "./native-agent-environment";

/** Web display indexes only; the CLI retains its native ~/.claude state. */
export function getClaudeWebDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.OMP_WEB_CC_STATE_DIR || join(homedir(), ".local", "state", "omp-web", "claude-code"));
}
export function getClaudeConfig(env: NodeJS.ProcessEnv = process.env) {
  const executable = getAgentExecutable("claude", env);
  if (!isAbsolute(executable)) throw new Error("Claude Code executable was not found; install the native CLI or set its absolute path.");
  return { executable, stateDir: getClaudeWebDir(env) };
}

/** Preserve native login, provider and config environment. Never load proxy keys. */
export function claudeChildEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const child = nativeAgentEnvironment(env);
  // These are metadata from a parent OMP/Pi process, not Claude configuration.
  delete child.OMP_CODING_AGENT_DIR;
  delete child.PI_CODING_AGENT_DIR;
  delete child.PI_CODING_AGENT_SESSION_DIR;
  return child;
}
