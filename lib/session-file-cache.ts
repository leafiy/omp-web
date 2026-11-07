import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { SessionEntry } from "./types";

type Snapshot = { version: string; bytes: number; entries: SessionEntry[] };
declare global { var __ompWebFileSnapshots: Map<string, Snapshot> | undefined; }
const MAX_BYTES = 64 * 1024 * 1024;

export function sessionFileVersion(path: string): string {
  const s = statSync(path, { bigint: true });
  if (!s.isFile()) throw new Error("Not a session file");
  return createHash("sha256").update(`${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`).digest("hex").slice(0, 32);
}

/** In-memory read-only snapshots; every lookup validates file identity. */
export function readSessionSnapshot(path: string): Snapshot {
  const key = resolve(path), version = sessionFileVersion(path);
  const cache = globalThis.__ompWebFileSnapshots ??= new Map();
  const previous = cache.get(key);
  if (previous?.version === version) { cache.delete(key); cache.set(key, previous); return previous; }
  cache.delete(key);
  const text = readFileSync(path, "utf8");
  if (sessionFileVersion(path) !== version) throw new Error("Session changed while reading; retry");
  const entries: SessionEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line) as SessionEntry); } catch { /* Native writers may have an unfinished final line. */ }
  }
  const snapshot = { version, bytes: Buffer.byteLength(text) * 3, entries };
  if (snapshot.bytes <= MAX_BYTES) {
    cache.set(key, snapshot);
    let bytes = [...cache.values()].reduce((n, item) => n + item.bytes, 0);
    for (const [oldKey, item] of cache) {
      if (cache.size <= 16 && bytes <= MAX_BYTES) break;
      cache.delete(oldKey); bytes -= item.bytes;
    }
  }
  return snapshot;
}
