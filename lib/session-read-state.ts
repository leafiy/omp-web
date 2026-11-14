import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";

export interface SessionReadSnapshot {
  revision: number;
  unread: Record<string, number>;
}

/** Web-owned completion receipts, shared by all browsers, never native history. */
export class SessionReadState {
  private state: SessionReadSnapshot;
  // Deliberately not restored: a server restart is not a completed agent turn.
  private running = new Set<string>();

  constructor(private readonly path: string) {
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (!Number.isSafeInteger(value.revision) || value.revision < 0 || !value.unread || typeof value.unread !== "object" || Array.isArray(value.unread)
        || Object.values(value.unread).some(v => !Number.isSafeInteger(v) || Number(v) <= 0 || Number(v) > value.revision)) {
        throw new Error("Invalid session read state");
      }
      this.state = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.state = { revision: 0, unread: {} };
    }
  }

  snapshot(): SessionReadSnapshot {
    return { revision: this.state.revision, unread: { ...this.state.unread } };
  }

  private commit(unread: Record<string, number>): void {
    const next = { revision: this.state.revision + 1, unread };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(this.path, JSON.stringify(next) + "\n");
    this.state = next;
  }

  observeRunning(ids: string[]): void {
    const next = new Set(ids);
    const unread = Object.assign(Object.create(null), this.state.unread) as Record<string, number>;
    let changed = false;
    for (const id of next) {
      if (Object.hasOwn(unread, id)) { delete unread[id]; changed = true; }
    }
    for (const id of this.running) {
      if (!next.has(id)) { unread[id] = this.state.revision + 1; changed = true; }
    }
    if (changed) this.commit(unread);
    this.running = next;
  }

  /** A late read receipt must never acknowledge a newer completion. */
  acknowledge(receipts: Record<string, number>): SessionReadSnapshot {
    const unread = { ...this.state.unread };
    let changed = false;
    for (const [id, version] of Object.entries(receipts)) {
      if (Object.hasOwn(unread, id) && unread[id] === version) {
        delete unread[id]; changed = true;
      }
    }
    if (changed) this.commit(unread);
    return this.snapshot();
  }
}

declare global {
  var __ompWebSessionReadState: SessionReadState | undefined;
}

export function sessionReadState(): SessionReadState {
  const path = process.env.OMP_WEB_READ_STATE_FILE?.trim()
    || join(homedir(), ".config", "omp-web", "session-read-state.json");
  if (!isAbsolute(path)) throw new Error("OMP_WEB_READ_STATE_FILE must be an absolute path");
  return globalThis.__ompWebSessionReadState ??= new SessionReadState(path);
}
