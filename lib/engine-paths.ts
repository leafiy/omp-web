import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentEngine } from "./engine";
import { getOmpAgentDir } from "./file-paths";
import { getClaudeWebDir } from "./claude-code-config";
import { getCodexWebDir } from "./codex-config";

/** PI_CODING_AGENT_DIR belongs to the deployed OMP service, not the Pi child. */
export function getPiAgentDir(): string {
  const directory = resolve(process.env.OMP_WEB_PI_AGENT_DIR || join(homedir(), ".pi", "agent"));
  let piDirectory = directory;
  let ompDirectory = resolve(getOmpAgentDir());
  try { piDirectory = realpathSync(piDirectory); } catch { /* The first Pi session may create this directory. */ }
  try { ompDirectory = realpathSync(ompDirectory); } catch { /* No existing OMP directory to resolve. */ }
  if (piDirectory === ompDirectory) throw new Error("OMP and Pi must use separate agent directories; change OMP_WEB_PI_AGENT_DIR.");
  return directory;
}

export function getEngineAgentDir(engine: AgentEngine): string {
  if (engine === "codex") return getCodexWebDir();
  if (engine === "claude") return getClaudeWebDir();
  return engine === "pi" ? getPiAgentDir() : getOmpAgentDir();
}
