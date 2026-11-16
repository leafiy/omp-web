import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";

export interface SessionPinSnapshot {
  revision: number;
  /** Newest pin first; IDs retain their engine-qualified web identity. */
  pinnedSessionIds: string[];
}

export function isSessionPinId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512;
}

/** Web-owned sidebar preferences shared by all devices, never native history. */
export class SessionPinState {
  private state: SessionPinSnapshot;

  constructor(private readonly path: string) {
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0
        || !Array.isArray(value.pinnedSessionIds) || !value.pinnedSessionIds.every(isSessionPinId)
        || new Set(value.pinnedSessionIds).size !== value.pinnedSessionIds.length) {
        throw new Error("Invalid session pin state");
      }
      this.state = { revision: value.revision, pinnedSessionIds: value.pinnedSessionIds };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = { revision: 0, pinnedSessionIds: [] };
    }
  }

  snapshot(): SessionPinSnapshot {
    return { revision: this.state.revision, pinnedSessionIds: [...this.state.pinnedSessionIds] };
  }

  /** Apply one explicit intent, not a stale device's entire list or a toggle. */
  setPinned(id: string, pinned: boolean): SessionPinSnapshot {
    if (!isSessionPinId(id) || typeof pinned !== "boolean") throw new Error("Invalid session pin update");
    if (this.state.pinnedSessionIds.includes(id) === pinned) return this.snapshot();
    const next = {
      revision: this.state.revision + 1,
      pinnedSessionIds: pinned
        ? [id, ...this.state.pinnedSessionIds]
        : this.state.pinnedSessionIds.filter((item) => item !== id),
    };
    // Synchronous read/modify/commit on the shared instance serializes requests.
    // A failed write leaves both the published snapshot and the old file intact.
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(this.path, JSON.stringify(next) + "\n");
    this.state = next;
    return this.snapshot();
  }
}

declare global {
  var __ompWebSessionPinState: SessionPinState | undefined;
}

export function sessionPinState(): SessionPinState {
  const path = process.env.OMP_WEB_PIN_STATE_FILE?.trim()
    || join(homedir(), ".config", "omp-web", "session-pin-state.json");
  if (!isAbsolute(path)) throw new Error("OMP_WEB_PIN_STATE_FILE must be an absolute path");
  return globalThis.__ompWebSessionPinState ??= new SessionPinState(path);
}
