import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, type Dirent, type Stats } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { getPiAgentDir } from "./engine-paths";
import { getOmpAgentDir } from "./file-paths";

/**
 * Day/week/month token totals for engines whose native interfaces expose none:
 * Claude Code's /usage reports quota percentages, the current session and
 * request counts, and OMP/Pi RPC report one session. Each assistant record's
 * own native usage is summed once, keyed by its native identity, so content
 * blocks, forks and resumed copies are not counted twice.
 *
 * A background pass reads only bytes appended since the persisted offset of
 * each file. The persisted summary holds 15-minute totals, hashed record keys
 * and file offsets for the retention window — never transcript text.
 */

export type LocalTokenEngine = "claude" | "omp" | "pi";
export const LOCAL_TOKEN_ENGINES: readonly LocalTokenEngine[] = ["claude", "omp", "pi"];
/** input, output, cache read, cache write */
export type TokenParts = [number, number, number, number];
export interface LocalUsageRecord { key: string; at: number; parts: TokenParts }
export interface LocalPeriodRow { engine: LocalTokenEngine; complete: boolean; periods: TokenParts[] }
export interface LocalTokenSnapshot { rows: LocalPeriodRow[]; pending: boolean; scannedAt: string | null }

const MINUTE = 60_000, QUARTER = 15 * MINUTE, DAY = 24 * 60 * MINUTE;
/** Covers the longest calendar month plus any time-zone offset. */
export const LOCAL_TOKEN_RETENTION_MS = 40 * DAY;
const REFRESH_INTERVAL_MS = 5 * MINUTE, MIN_REFRESH_GAP_MS = 60_000, FORCED_REFRESH_GAP_MS = 5_000;
const CHUNK_BYTES = 1 << 20, MAX_LINE_BYTES = 64 << 20, MAX_DEPTH = 4, STATE_VERSION = 1, LF = 10;
const USAGE = Buffer.from('"usage"'), ASSISTANT = Buffer.from('"assistant"');

interface FileMark { size: number; mtimeMs: number; ino: number; offset: number }
interface EngineState {
  root: string;
  /** At least one whole pass finished; totals before that are incomplete. */
  complete: boolean;
  files: Record<string, FileMark>;
  /** 15-minute UTC bucket index → summed parts. */
  buckets: Record<string, TokenParts>;
  /** UTC day index → hashed record keys first seen that day (pruned with the window). */
  keys: Record<string, string[]>;
}
interface PersistedState { version: number; scannedAt: string | null; engines: Partial<Record<LocalTokenEngine, EngineState>> }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function count(value: unknown): number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0; }

/** One native assistant record's usage, or null for anything else. */
export function parseUsageLine(engine: LocalTokenEngine, line: string): LocalUsageRecord | null {
  let entry: Record<string, unknown> | null;
  try { entry = record(JSON.parse(line)); } catch { return null; }
  const message = record(entry?.message), usage = record(message?.usage);
  if (!entry || !message || !usage) return null;
  if (engine === "claude") {
    // Claude Code writes one line per content block, each repeating the response's final usage.
    if (entry.type !== "assistant") return null;
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    const id = typeof message.id === "string" ? message.id : "", request = typeof entry.requestId === "string" ? entry.requestId : "";
    const key = id || request ? `${id}:${request}` : typeof entry.uuid === "string" ? entry.uuid : "";
    if (!key || !Number.isFinite(at)) return null;
    return { key, at, parts: [count(usage.input_tokens), count(usage.output_tokens), count(usage.cache_read_input_tokens), count(usage.cache_creation_input_tokens)] };
  }
  // OMP/Pi: one entry per assistant message; branches/forks copy the entry with its ID and timestamp.
  if (entry.type !== "message" || message.role !== "assistant") return null;
  const at = typeof message.timestamp === "number" ? message.timestamp : typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
  if (!Number.isFinite(at)) return null;
  const parts: TokenParts = [count(usage.input), count(usage.output), count(usage.cacheRead), count(usage.cacheWrite)];
  return { key: typeof entry.id === "string" && entry.id ? `${entry.id}:${at}` : `${at}:${parts.join(",")}`, at, parts };
}

function validEngineState(value: unknown): value is EngineState {
  const state = record(value), files = record(state?.files), buckets = record(state?.buckets), keys = record(state?.keys);
  return !!state && typeof state.root === "string" && typeof state.complete === "boolean" && !!files && !!buckets && !!keys
    && Object.values(files).every((mark) => { const m = record(mark); return !!m && [m.size, m.mtimeMs, m.ino, m.offset].every((n) => typeof n === "number" && Number.isFinite(n)); })
    && Object.values(buckets).every((parts) => Array.isArray(parts) && parts.length === 4 && parts.every((n) => Number.isSafeInteger(n) && n >= 0))
    && Object.values(keys).every((hashes) => Array.isArray(hashes) && hashes.every((hash) => typeof hash === "string"));
}

async function* walk(directory: string, depth: number): AsyncGenerator<string> {
  let entries: Dirent[];
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    // Symlinks are neither files nor directories here: no loops, no escaping the store.
    if (entry.isDirectory() && depth < MAX_DEPTH) yield* walk(path, depth + 1);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
  }
}

/**
 * Calls onLine for complete LF-terminated lines in [start, end) that may hold
 * assistant usage, and returns the offset after the last complete line so a
 * line still being written is read again, whole, next time.
 */
async function readCompleteLines(path: string, start: number, end: number, onLine: (line: string) => void): Promise<number> {
  const handle = await open(path, "r");
  try {
    if (start > 0) {
      const probe = Buffer.alloc(1), { bytesRead } = await handle.read(probe, 0, 1, start - 1);
      // The prefix changed length: reread the file; record keys prevent double counts.
      if (bytesRead !== 1 || probe[0] !== LF) start = 0;
    }
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = start, pending: Buffer[] = [], pendingBytes = 0, oversized = false;
    while (position < end) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK_BYTES, end - position), position);
      if (!bytesRead) break;
      position += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);
      let from = 0;
      for (let lf = chunk.indexOf(LF); lf !== -1; lf = chunk.indexOf(LF, from)) {
        if (!oversized) {
          const tail = chunk.subarray(from, lf), line = pendingBytes ? Buffer.concat([...pending, tail]) : tail;
          if (line.includes(USAGE) && line.includes(ASSISTANT)) onLine(line.toString("utf8"));
        }
        pending = []; pendingBytes = 0; oversized = false; from = lf + 1;
      }
      if (from < bytesRead) {
        pendingBytes += bytesRead - from;
        if (pendingBytes > MAX_LINE_BYTES) { oversized = true; pending = []; }
        else if (!oversized) pending.push(Buffer.from(chunk.subarray(from)));
      }
    }
    return position - pendingBytes;
  } finally { await handle.close(); }
}

function addUsage(state: EngineState, seen: Set<string>, usage: LocalUsageRecord, cutoff: number, latest: number): boolean {
  if (usage.at < cutoff || usage.at > latest || usage.parts.every((n) => n === 0)) return false;
  const hash = createHash("sha256").update(usage.key).digest("base64url").slice(0, 16);
  if (seen.has(hash)) return false;
  seen.add(hash);
  (state.keys[String(Math.floor(usage.at / DAY))] ??= []).push(hash);
  const bucket = state.buckets[String(Math.floor(usage.at / QUARTER))] ??= [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) bucket[i] += usage.parts[i];
  return true;
}

function prune(state: EngineState, seen: Set<string>, cutoff: number): boolean {
  const firstDay = Math.floor(cutoff / DAY), firstQuarter = Math.floor(cutoff / QUARTER);
  let changed = false;
  for (const [day, hashes] of Object.entries(state.keys)) {
    if (Number(day) >= firstDay) continue;
    for (const hash of hashes) seen.delete(hash);
    delete state.keys[day]; changed = true;
  }
  for (const quarter of Object.keys(state.buckets)) if (Number(quarter) < firstQuarter) { delete state.buckets[quarter]; changed = true; }
  return changed;
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

export interface LocalTokenTrackerOptions {
  roots: () => Partial<Record<LocalTokenEngine, string>>;
  statePath: string;
  now?: () => number;
  /** Background refresh period; false disables the timer (tests). */
  interval?: number | false;
}

export function createLocalTokenTracker(options: LocalTokenTrackerOptions) {
  const now = options.now ?? Date.now, seen = new Map<LocalTokenEngine, Set<string>>(), present = new Map<LocalTokenEngine, boolean>();
  let state: PersistedState | null = null, refreshing: Promise<void> | null = null, lastStarted = -Infinity, dirty = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function load(): PersistedState {
    if (state) return state;
    const loaded: PersistedState = { version: STATE_VERSION, scannedAt: null, engines: {} };
    try {
      const parsed = record(JSON.parse(readFileSync(options.statePath, "utf8")));
      if (parsed?.version === STATE_VERSION) {
        loaded.scannedAt = typeof parsed.scannedAt === "string" ? parsed.scannedAt : null;
        for (const engine of LOCAL_TOKEN_ENGINES) {
          const value = record(parsed.engines)?.[engine];
          if (validEngineState(value)) loaded.engines[engine] = value;
        }
      }
    } catch { /* First run or unreadable summary: the next pass rebuilds it. */ }
    for (const [engine, value] of Object.entries(loaded.engines) as [LocalTokenEngine, EngineState][]) seen.set(engine, new Set(Object.values(value.keys).flat()));
    return state = loaded;
  }

  async function scanEngine(engine: LocalTokenEngine, current: EngineState, keys: Set<string>): Promise<boolean> {
    const at = now(), cutoff = at - LOCAL_TOKEN_RETENTION_MS, latest = at + DAY, found = new Set<string>();
    let changed = false;
    for await (const path of walk(current.root, 0)) {
      found.add(path);
      let info: Stats;
      try { info = await stat(path); } catch { continue; }
      const mark = current.files[path];
      // Not written within the window, so it holds nothing to count; read it again if it changes.
      if (info.mtimeMs < cutoff) { if (mark) { delete current.files[path]; changed = true; } continue; }
      if (mark && mark.ino === info.ino && mark.size === info.size && mark.mtimeMs === info.mtimeMs) continue;
      const resume = mark && mark.ino === info.ino && info.size >= mark.offset ? mark.offset : 0;
      try {
        const offset = await readCompleteLines(path, resume, info.size, (line) => {
          const usage = parseUsageLine(engine, line);
          if (usage && addUsage(current, keys, usage, cutoff, latest)) changed = true;
        });
        current.files[path] = { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, offset };
        changed = true;
      } catch { /* Vanished or unreadable now; the next pass retries. */ }
    }
    // A deleted transcript's usage still happened; only its offset is dropped.
    for (const path of Object.keys(current.files)) if (!found.has(path)) { delete current.files[path]; changed = true; }
    if (prune(current, keys, cutoff)) changed = true;
    if (!current.complete) { current.complete = true; changed = true; }
    return changed;
  }

  function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    lastStarted = now();
    refreshing = (async () => {
      const current = load(), roots = options.roots();
      const enabled = await Promise.all(LOCAL_TOKEN_ENGINES.map(async (engine) => {
        const root = roots[engine], exists = !!root && await isDirectory(root);
        present.set(engine, exists);
        return exists ? { engine, root: root! } : null;
      }));
      // Every installed engine gets a (pending) row before the first, possibly long, scan starts.
      for (const item of enabled) {
        if (!item) continue;
        const engineState = current.engines[item.engine];
        if (engineState && engineState.root === item.root) continue;
        current.engines[item.engine] = { root: item.root, complete: false, files: {}, buckets: {}, keys: {} };
        seen.set(item.engine, new Set()); dirty = true;
      }
      for (const item of enabled) {
        if (item && await scanEngine(item.engine, current.engines[item.engine]!, seen.get(item.engine)!)) dirty = true;
      }
      current.scannedAt = new Date(now()).toISOString();
      if (dirty) {
        mkdirSync(dirname(options.statePath), { recursive: true, mode: 0o700 });
        writePrivateFileAtomicSync(options.statePath, JSON.stringify(current));
        dirty = false;
      }
    })().catch(() => { /* Persisting failed; in-memory totals stay usable and the next pass saves again. */ })
      .finally(() => { refreshing = null; });
    return refreshing;
  }

  /** Starts the background timer on first use and refreshes when the last pass is old. */
  function ensure(force = false): Promise<void> {
    if (!timer && options.interval !== false) {
      timer = setInterval(() => { void refresh(); }, options.interval ?? REFRESH_INTERVAL_MS);
      timer.unref?.();
    }
    if (refreshing) return refreshing;
    if (now() - lastStarted < (force ? FORCED_REFRESH_GAP_MS : MIN_REFRESH_GAP_MS)) return Promise.resolve();
    return refresh();
  }

  /** Sums for each start instant (ms) up to now; engines without a store on this machine are omitted. */
  function periods(starts: readonly number[]): LocalPeriodRow[] {
    const current = load(), rows: LocalPeriodRow[] = [];
    for (const engine of LOCAL_TOKEN_ENGINES) {
      const engineState = current.engines[engine];
      if (!engineState || present.get(engine) === false) continue;
      const firsts = starts.map((start) => Math.floor(start / QUARTER)), totals = starts.map((): TokenParts => [0, 0, 0, 0]);
      for (const [quarter, parts] of Object.entries(engineState.buckets)) {
        const index = Number(quarter);
        firsts.forEach((first, i) => { if (index >= first) for (let k = 0; k < 4; k++) totals[i][k] += parts[k]; });
      }
      rows.push({ engine, complete: engineState.complete, periods: totals });
    }
    return rows;
  }

  return {
    ensure, refresh, periods,
    isRefreshing: () => refreshing !== null,
    scannedAt: () => load().scannedAt,
    stop: () => { clearInterval(timer); timer = undefined; },
  };
}
export type LocalTokenTracker = ReturnType<typeof createLocalTokenTracker>;

/** Native stores only; the web's own Claude/Codex projections are not scanned (no double counts). */
export function defaultLocalTokenRoots(): Partial<Record<LocalTokenEngine, string>> {
  const roots: Partial<Record<LocalTokenEngine, string>> = {
    claude: join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects"),
    omp: join(getOmpAgentDir(), "sessions"),
  };
  try { roots.pi = join(getPiAgentDir(), "sessions"); } catch { /* Pi misconfigured onto OMP's store: never count it twice. */ }
  return roots;
}

export function defaultLocalTokenStatePath(): string {
  return join(process.env.OMP_WEB_USAGE_STATE_DIR || join(homedir(), ".local", "state", "omp-web", "usage"), "local-tokens.json");
}

declare global { var __ompWebLocalTokens: LocalTokenTracker | undefined }
export function localTokenTracker(): LocalTokenTracker {
  return globalThis.__ompWebLocalTokens ??= createLocalTokenTracker({ roots: defaultLocalTokenRoots, statePath: defaultLocalTokenStatePath() });
}

/** Waits briefly for a pass so a warm summary answers immediately and a cold first scan reports progress. */
export async function localTokenSnapshot(starts: readonly number[], force: boolean, waitMs = 3000): Promise<LocalTokenSnapshot> {
  const tracker = localTokenTracker();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([tracker.ensure(force), new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); })]);
  clearTimeout(timer);
  return { rows: tracker.periods(starts), pending: tracker.isRefreshing(), scannedAt: tracker.scannedAt() };
}
