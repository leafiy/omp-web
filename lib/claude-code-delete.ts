import { deleteSession } from "@anthropic-ai/claude-agent-sdk";
import { lstatSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { getClaudeWebDir } from "./claude-code-config";
import { engineForSession, nativeSessionId } from "./engine";
import { readSessionHeader } from "./session-reader";

/** Native history is owned by Claude; never treat the display JSONL as its context.
 * Call under withIdleSessionDeletion so no web process can recreate either file.
 */
export async function deleteClaudeSession(
  id: string,
  projectionPath: string,
  removeNative: typeof deleteSession = deleteSession,
): Promise<void> {
  const nativeId = nativeSessionId(id);
  if (engineForSession(id) !== "claude" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeId)) {
    throw new Error("Invalid Claude session identity");
  }
  const expectedPath = join(getClaudeWebDir(), "sessions", `${nativeId}.jsonl`);
  if (resolve(projectionPath) !== expectedPath || !lstatSync(projectionPath).isFile()) {
    throw new Error("Claude web projection path does not match session identity");
  }
  const header = readSessionHeader(projectionPath) as { id?: string; cwd?: string; projection?: string } | null;
  if (header?.id !== nativeId || header.projection !== "claude-code" || !header.cwd || !isAbsolute(header.cwd)) {
    throw new Error("Invalid Claude web projection header");
  }
  try {
    // Exact UUID + recorded cwd. SDK removes the transcript and its subagents,
    // using the same native CLAUDE_CONFIG_DIR/HOME as the local Claude adapter.
    await removeNative(nativeId, { dir: header.cwd });
  } catch (error) {
    // Empty drafts have no native history yet; retries after external/native
    // deletion must still be able to clear the stale web projection. Do not
    // swallow permission/I/O failures or remove the only remaining retry index.
    if (!(error instanceof Error) || error.message !== `Session ${nativeId} not found in project directory for ${header.cwd}`) throw error;
  }
  unlinkSync(projectionPath);
}
