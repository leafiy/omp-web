import { getClaudeWebDir } from "./claude-code-config";
import { WebSessionTranscript } from "./web-session-transcript";

/** Claude owns native context; the shared store is a webpage-only projection. */
export class ClaudeWebTranscript extends WebSessionTranscript {
  constructor(nativeId: string, cwd: string, existingPath?: string) {
    super(nativeId, cwd, getClaudeWebDir(), "claude-code", existingPath);
  }
}
