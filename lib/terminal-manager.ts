import { spawn, type IPty } from "@lydell/node-pty";
import { TERMINAL_MAX_INPUT, isTerminalId, isTerminalSize, type TerminalEvent, type TerminalInfo, type TerminalSize } from "./terminal-contract";

const REPLAY_LIMIT = 256 * 1024;
const DETACHED_TIMEOUT = 30 * 60_000;
const MAX_TERMINALS = 8;
type RecordedEvent = Extract<TerminalEvent, { seq: number }>;
type Listener = (event: TerminalEvent) => void;
type Pty = Pick<IPty, "pid" | "write" | "resize" | "kill" | "onData" | "onExit">;
type SpawnShell = (cwd: string, size: TerminalSize) => Pty;

export class TerminalError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function spawnShell(cwd: string, size: TerminalSize): Pty {
  // Shells run as the web service user, NOT in a sandbox. Do not expose the
  // web password or agent session metadata to programs launched here.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
    value !== undefined && !key.startsWith("PI_WEB_") && !key.startsWith("PI_SESSION_") && !key.startsWith("OMP_WEB_AUTH")
  )) as Record<string, string>;
  return spawn(process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/bash", [], {
    name: "xterm-256color", cwd, cols: size.cols, rows: size.rows,
    env: { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" },
  });
}

export class TerminalSession {
  private listeners = new Set<Listener>();
  private history: RecordedEvent[] = [];
  private historyLength = 0;
  private seq = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private alive = true;
  private disposed = false;
  private subscriptions: Array<{ dispose(): void }> = [];

  constructor(
    readonly id: string,
    readonly cwd: string,
    private pty: Pty,
    private expire: () => void,
    private detachedTimeout: number,
  ) {
    this.subscriptions.push(pty.onData((data) => {
      // Bound each SSE frame as well as the replay buffer.
      for (let offset = 0; offset < data.length; offset += 8192) {
        this.publish({ type: "output", seq: ++this.seq, data: data.slice(offset, offset + 8192) });
      }
    }));
    this.subscriptions.push(pty.onExit(({ exitCode }) => {
      if (this.disposed) return;
      this.alive = false;
      this.publish({ type: "exit", seq: ++this.seq, exitCode });
      // Exited sessions expire even if a browser keeps its stream open.
      this.armExpiry();
    }));
    this.armExpiry();
  }

  get info(): TerminalInfo {
    return { id: this.id, cwd: this.cwd, pid: this.pty.pid, alive: this.alive };
  }

  private armExpiry() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(this.expire, this.detachedTimeout);
    this.idleTimer.unref();
  }

  private publish(event: RecordedEvent) {
    this.history.push(event);
    if (event.type === "output") this.historyLength += event.data.length;
    while (this.historyLength > REPLAY_LIMIT || this.history.length > 4096) {
      const removed = this.history.shift()!;
      if (removed.type === "output") this.historyLength -= removed.data.length;
    }
    for (const listener of this.listeners) listener(event);
  }

  subscribe(after: number, listener: Listener): () => void {
    if (this.disposed) throw new TerminalError("Terminal has closed", 404);
    if (this.alive) clearTimeout(this.idleTimer);
    const first = this.history[0]?.seq ?? this.seq + 1;
    if (after < first - 1 || after > this.seq) {
      listener({ type: "reset" });
      after = 0;
    }
    for (const event of this.history) if (event.seq > after) listener(event);
    listener({ type: "ready", terminal: this.info });
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (!this.disposed && this.listeners.size === 0) this.armExpiry();
    };
  }

  write(data: string) {
    if (!this.alive || this.disposed) throw new TerminalError("Terminal has exited", 409);
    if (typeof data !== "string" || data.length > TERMINAL_MAX_INPUT) throw new TerminalError("Invalid terminal input", 400);
    this.pty.write(data);
  }

  /** Defers detached expiry for a live shell shown in an inactive browser tab. */
  keepAlive() {
    if (this.disposed) throw new TerminalError("Terminal has closed", 404);
    if (this.alive && this.listeners.size === 0) this.armExpiry();
  }

  resize(size: TerminalSize) {
    if (!isTerminalSize(size)) throw new TerminalError("Invalid terminal size", 400);
    if (this.alive && !this.disposed) this.pty.resize(size.cols, size.rows);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.idleTimer);
    for (const subscription of this.subscriptions) subscription.dispose();
    if (this.alive) {
      this.alive = false;
      // Notify connected clients before releasing the terminal.
      this.publish({ type: "exit", seq: ++this.seq, exitCode: -1 });
      try { this.pty.kill(); } catch { /* already exited */ }
    }
    this.listeners.clear();
    this.history = [];
  }
}

export class TerminalRegistry {
  private sessions = new Map<string, TerminalSession>();
  constructor(private spawnPty: SpawnShell = spawnShell, private detachedTimeout = DETACHED_TIMEOUT) {}

  open(id: string, cwd: string, size: TerminalSize): TerminalInfo {
    if (!isTerminalId(id) || !isTerminalSize(size)) throw new TerminalError("Invalid terminal request", 400);
    const existing = this.sessions.get(id);
    if (existing) {
      if (existing.cwd !== cwd) throw new TerminalError("Terminal belongs to another directory", 409);
      existing.resize(size);
      return existing.info;
    }
    if (this.sessions.size >= MAX_TERMINALS) throw new TerminalError("Terminal limit reached (8). Terminate an unused terminal first.", 429);
    const terminal = new TerminalSession(id, cwd, this.spawnPty(cwd, size), () => this.close(id), this.detachedTimeout);
    this.sessions.set(id, terminal);
    return terminal.info;
  }

  get(id: string): TerminalSession {
    const terminal = this.sessions.get(id);
    if (!terminal) throw new TerminalError("Terminal not found or expired. Start a new terminal.", 404);
    return terminal;
  }

  close(id: string) {
    const terminal = this.sessions.get(id);
    this.sessions.delete(id);
    terminal?.dispose();
  }
}

declare global {
  var __ompTerminalRegistry: TerminalRegistry | undefined;
}

export function getTerminalRegistry(): TerminalRegistry {
  return globalThis.__ompTerminalRegistry ??= new TerminalRegistry();
}
