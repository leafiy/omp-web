import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentExecutable } from "./agent-executable";
import { nativeAgentEnvironment } from "./native-agent-environment";
import { TextDecoder } from "node:util";
import { getOmpAgentDir } from "./file-paths";
import { getPiAgentDir } from "./engine-paths";
import { parseEngine, type AgentEngine } from "./engine";

export interface AgentFrame {
  type: string;
  [key: string]: unknown;
}

export function getOmpExecutable(): string { return getAgentExecutable("omp"); }

/** Select native Pi, never the web package's older history-reader dependency. */
export function getPiExecutable(): string { return getAgentExecutable("pi"); }

const MAX_LOGICAL_BYTES = 64 * 1024 * 1024;
const START_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 60_000;

/** LF-only JSONL framing, including OMP's opt-in lossless v2 chunk transport. */
export class AgentFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private chunk?: { id: string; count: number; length: number; parts: Buffer[]; bytes: number };
  maxFrameBytes = 1024 * 1024;
  maxLogicalBytes = MAX_LOGICAL_BYTES;

  constructor(private readonly allowChunks = true) {}

  push(data: Buffer, onFrame: (frame: AgentFrame) => void): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    let end: number;
    while ((end = this.buffer.indexOf(10)) !== -1) {
      if (end + 1 > this.maxFrameBytes) throw new Error("Agent RPC frame exceeds transport limit");
      const line = this.buffer.subarray(0, end);
      this.buffer = this.buffer.subarray(end + 1);
      if (line.length === 0) continue;
      this.accept(this.parse(line), onFrame);
    }
    if (this.buffer.length > this.maxFrameBytes) throw new Error("Unterminated agent RPC frame exceeds transport limit");
  }

  finish(): void {
    if (this.buffer.length || this.chunk) throw new Error("Agent closed stdout in the middle of an RPC frame");
  }

  private parse(bytes: Buffer): AgentFrame {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as AgentFrame).type !== "string") {
      throw new Error("Invalid agent RPC frame");
    }
    return value as AgentFrame;
  }

  private accept(frame: AgentFrame, onFrame: (frame: AgentFrame) => void): void {
    if (frame.type !== "rpc_chunk") {
      if (this.chunk) throw new Error("Interrupted OMP RPC chunk sequence");
      onFrame(frame);
      return;
    }
    if (!this.allowChunks) throw new Error("Pi RPC does not support chunk frames");
    const { chunkId, index, count, byteLength, data } = frame;
    if (typeof chunkId !== "string" || !chunkId || !Number.isSafeInteger(index) || !Number.isSafeInteger(count)
      || !Number.isSafeInteger(byteLength) || typeof data !== "string"
      || (count as number) < 1 || (count as number) > this.maxLogicalBytes
      || (byteLength as number) < 1 || (byteLength as number) > this.maxLogicalBytes
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
      throw new Error("Invalid OMP RPC chunk metadata");
    }
    if (!this.chunk) {
      if (index !== 0) throw new Error("OMP RPC chunks must start at zero");
      this.chunk = { id: chunkId, count: count as number, length: byteLength as number, parts: [], bytes: 0 };
    }
    const chunk = this.chunk;
    if (chunk.id !== chunkId || chunk.count !== count || chunk.length !== byteLength || index !== chunk.parts.length) {
      throw new Error("Out-of-order OMP RPC chunks");
    }
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length || chunk.bytes + bytes.length > chunk.length) throw new Error("OMP RPC chunk size mismatch");
    chunk.parts.push(bytes);
    chunk.bytes += bytes.length;
    if (chunk.parts.length === chunk.count) {
      if (chunk.bytes !== chunk.length) throw new Error("Incomplete OMP RPC chunk payload");
      const decoded = this.parse(Buffer.concat(chunk.parts, chunk.bytes));
      this.chunk = undefined;
      if (decoded.type === "rpc_chunk") throw new Error("Nested OMP RPC chunks are not supported");
      onFrame(decoded);
    }
  }
}

type PendingRequest = {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export interface AgentProcessOptions {
  cwd: string;
  engine?: AgentEngine;
  sessionFile?: string;
  initialModel?: { provider: string; modelId: string };
  thinkingLevel?: string;
  /** Catalog queries never persist sessions. */
  catalogOnly?: boolean;
  /** Isolated, ephemeral title generation with a native tool-denial guard. */
  titleOnly?: boolean;
}

type TitleGuard = {
  directory: string;
  marker: string;
  ready: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

function createTitleGuard(): TitleGuard {
  const directory = mkdtempSync(join(tmpdir(), "omp-web-title-"));
  const marker = `omp-web:title-tools:${randomUUID()}:`;
  const { promise: ready, resolve, reject } = Promise.withResolvers<void>();
  void ready.catch(() => {});
  try {
    // Both installed engines expose these native extension controls. Merely
    // hiding built-in tools is insufficient in OMP: custom/MCP tools can remain.
    writeFileSync(join(directory, "guard.mjs"), `export default function (pi) {
  const lock = async (_event, ctx) => {
    await pi.setActiveTools([]);
    ctx.ui.notify(${JSON.stringify(marker)} + JSON.stringify(pi.getActiveTools()), "info");
  };
  pi.on("session_start", lock);
  pi.on("before_agent_start", lock);
  pi.on("tool_call", () => ({ block: true, reason: "Tools are disabled for conversation title generation." }));
}
`, { mode: 0o600 });
    return { directory, marker, ready, resolve, reject };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Owns native subprocesses and transport; model/auth decisions stay in each CLI. */
export class AgentRpcClient {
  readonly engine: AgentEngine;
  private child: ChildProcessWithoutNullStreams;
  private decoder: AgentFrameDecoder;
  private pending = new Map<string, PendingRequest>();
  private listeners = new Set<(frame: AgentFrame) => void>();
  private closeListeners = new Set<(error: Error) => void>();
  private dead = false;
  private closing = false;
  private readyResolve!: (frame: AgentFrame) => void;
  private readyReject!: (error: Error) => void;
  private ready: Promise<AgentFrame>;
  private readyTimer: ReturnType<typeof setTimeout>;
  private startPromise?: Promise<void>;
  private closePromise: Promise<void>;
  private stderrTail = "";
  private shutdownPromise?: Promise<void>;
  private titleGuard?: TitleGuard;

  constructor(options: AgentProcessOptions, spawnProcess: typeof spawn = spawn) {
    this.engine = parseEngine(options.engine);
    if (this.engine === "claude" || this.engine === "codex") throw new Error(`${this.engine} requires its own adapter, not OMP/Pi RPC`);
    const pi = this.engine === "pi";
    this.decoder = new AgentFrameDecoder(!pi);
    // Pi has no readiness negotiation or chunk extension; bound its complete JSONL records.
    if (pi) this.decoder.maxFrameBytes = MAX_LOGICAL_BYTES;
    const args = ["--mode", pi || options.catalogOnly || options.titleOnly ? "rpc" : "rpc-ui"];
    if (options.titleOnly) {
      args.push("--no-session", "--no-tools", "--no-extensions", "--no-skills");
      if (pi) args.push("--no-mcp", "--no-prompt-templates", "--exclude-tools", "*");
      else args.push("--no-rules", "--no-context-files", "--no-lsp", "--no-pty", "--no-prewalk", "--no-title");
    } else if (options.catalogOnly) args.push(...(pi ? ["--no-session"] : ["--no-session", "--no-ui"]));
    // Title generation must never resume a caller's transcript, even by accident.
    // Pi --resume opens an interactive picker; --session is its exact-path option.
    if (options.sessionFile && !options.titleOnly) args.push(pi ? "--session" : "--resume", options.sessionFile);
    if (options.initialModel) args.push("--model", `${options.initialModel.provider}/${options.initialModel.modelId}`);
    if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
    const agentDir = pi ? getPiAgentDir() : getOmpAgentDir();
    const env: NodeJS.ProcessEnv = { ...nativeAgentEnvironment(), PI_CODING_AGENT_DIR: agentDir };
    if (pi) {
      // Do not inherit the hosting OMP's resource/config directories or session store.
      delete env.OMP_CODING_AGENT_DIR;
      delete env.PI_CODING_AGENT_SESSION_DIR;
    } else env.OMP_CODING_AGENT_DIR = agentDir;
    for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_MODEL", "PI_PROVIDER", "PI_REASONING_LEVEL"]) delete env[key];
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    void this.ready.catch(() => {});
    const executable = pi ? getPiExecutable() : getOmpExecutable();
    if (options.titleOnly) {
      this.titleGuard = createTitleGuard();
      args.push(pi ? "--extension" : "--trusted-extension", join(this.titleGuard.directory, "guard.mjs"));
    }
    try {
      this.child = spawnProcess(executable, args, { cwd: options.cwd, env, stdio: "pipe", shell: false, detached: process.platform !== "win32" });
    } catch (error) {
      if (this.titleGuard) rmSync(this.titleGuard.directory, { recursive: true, force: true });
      throw error;
    }
    this.readyTimer = setTimeout(() => this.fail(new Error(`Timed out waiting for local ${this.label} RPC. Check the installed engine and its configuration.`)), START_TIMEOUT_MS);
    this.closePromise = new Promise((resolve) => this.child.once("close", () => resolve()));
    this.child.on("error", (error) => this.fail(new Error(`Cannot start local ${this.label} (${executable}): ${error.message}`)));
    this.child.stdin.on("error", (error) => { if (!this.closing) this.fail(error); });
    this.child.stdout.on("data", (bytes: Buffer) => {
      try { this.decoder.push(bytes, (frame) => this.receive(frame)); }
      catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
    this.child.stderr.on("data", (bytes: Buffer) => {
      this.stderrTail = (this.stderrTail + bytes.toString("utf8")).slice(-4096);
    });
    this.child.on("close", (code, signal) => {
      let error = new Error(`Local ${this.label} exited (${signal ?? code ?? "unknown"}). ${this.stderrTail.trim()}`);
      try { this.decoder.finish(); } catch (failure) { error = failure instanceof Error ? failure : error; }
      this.finish(error);
      if (this.titleGuard) rmSync(this.titleGuard.directory, { recursive: true, force: true });
    });
  }

  private get label(): string { return this.engine === "pi" ? "Pi" : "OMP"; }

  start(): Promise<void> {
    return this.startPromise ??= (async () => {
      await this.initialize();
      if (this.titleGuard) {
        await this.titleGuard.ready;
        clearTimeout(this.readyTimer);
      }
    })();
  }

  private async initialize(): Promise<void> {
    if (this.engine === "pi") {
      // Pi emits no ready frame. stdin buffers this supported query until RPC has initialized.
      try {
        const state = await this.request<{ sessionId: string }>({ type: "get_state" }, START_TIMEOUT_MS);
        if (!state || typeof state.sessionId !== "string") throw new Error("Invalid local Pi session state");
        if (!this.titleGuard) clearTimeout(this.readyTimer);
        this.readyResolve({ type: "response", command: "get_state", success: true, data: state });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      return;
    }
    const ready = await this.ready;
    if (Array.isArray(ready.supportedProtocolVersions) && ready.supportedProtocolVersions.includes(2)) {
      await this.request({ type: "negotiate_protocol", protocolVersion: 2 });
    }
  }

  isAlive(): boolean { return !this.dead && !this.closing; }

  onFrame(listener: (frame: AgentFrame) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => { this.closeListeners.delete(listener); };
  }

  request<T = unknown>(command: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS, id = randomUUID()): Promise<T> {
    if (!this.isAlive()) return Promise.reject(new Error(`Local ${this.label} process is not running`));
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = { resolve: (value) => resolve(value as T), reject };
      if (timeoutMs > 0) pending.timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label} command '${String(command.type)}' timed out; it may still be running. Do not automatically retry.`));
      }, timeoutMs);
      this.pending.set(id, pending);
      try { this.write({ ...command, id }); }
      catch (error) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /** UI responses have their own correlation id and receive no RPC response. */
  write(frame: Record<string, unknown>): void {
    if (!this.isAlive()) throw new Error(`Local ${this.label} process is not running`);
    const line = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(line) > MAX_LOGICAL_BYTES) throw new Error(`${this.label} request is too large; attach the file by path instead`);
    this.child.stdin.write(line);
  }

  private receive(frame: AgentFrame): void {
    if (this.titleGuard) {
      if (frame.type === "extension_error") {
        this.fail(new Error(`Native title guard failed: ${String(frame.error ?? "unknown extension error")}`));
        return;
      }
      if (frame.type === "extension_ui_request" && frame.method === "notify"
        && typeof frame.message === "string" && frame.message.startsWith(this.titleGuard.marker)) {
        let tools: unknown;
        try { tools = JSON.parse(frame.message.slice(this.titleGuard.marker.length)); }
        catch { this.fail(new Error("Invalid native title tool attestation")); return; }
        if (!Array.isArray(tools) || tools.length !== 0) {
          this.fail(new Error("Native title process still exposes tools"));
          return;
        }
        this.titleGuard.resolve();
        return;
      }
    }
    if (this.engine === "omp" && frame.type === "ready") {
      if (!this.titleGuard) clearTimeout(this.readyTimer);
      if (typeof frame.maxFrameBytes === "number" && frame.maxFrameBytes > 0) {
        this.decoder.maxFrameBytes = Math.min(frame.maxFrameBytes, MAX_LOGICAL_BYTES);
      }
      if (typeof frame.maxReassembledFrameBytes === "number" && frame.maxReassembledFrameBytes > 0) {
        this.decoder.maxLogicalBytes = Math.min(frame.maxReassembledFrameBytes, MAX_LOGICAL_BYTES);
      }
      this.readyResolve(frame);
      return;
    }
    if (frame.type === "response" && typeof frame.id === "string") {
      const pending = this.pending.get(frame.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(frame.id);
        if (frame.success === true) pending.resolve(frame.data);
        else pending.reject(new Error(typeof frame.error === "string" ? frame.error : `${this.label} command failed`));
      }
    }
    for (const listener of this.listeners) {
      try { listener(frame); } catch (error) { console.error("[omp-web] RPC listener failed:", error); }
    }
  }

  private finish(error: Error): void {
    if (this.dead) return;
    this.dead = true;
    clearTimeout(this.readyTimer);
    this.readyReject(error);
    this.titleGuard?.reject(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.closeListeners) {
      try { listener(error); } catch (failure) { console.error("[omp-web] RPC close listener failed:", failure); }
    }
    this.listeners.clear();
    this.closeListeners.clear();
  }

  private signal(signal: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch { /* already exited */ }
  }

  private fail(error: Error): void {
    if (this.dead) return;
    this.finish(error);
    this.signal("SIGTERM");
    const kill = setTimeout(() => { if (this.child.exitCode === null) this.signal("SIGKILL"); }, 3000);
    kill.unref();
    this.child.once("close", () => clearTimeout(kill));
  }

  destroy(): void { this.fail(new Error(`Local ${this.label} session was closed`)); }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      if (this.dead) { await this.closePromise; return; }
      this.closing = true;
      // EOF lets the native engine flush its own transcript and release resources.
      this.child.stdin.end();
      const term = setTimeout(() => this.signal("SIGTERM"), 3000);
      const kill = setTimeout(() => this.signal("SIGKILL"), 6000);
      try { await this.closePromise; }
      finally { clearTimeout(term); clearTimeout(kill); }
    })();
    return this.shutdownPromise;
  }
}
