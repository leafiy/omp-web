import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";
import { CODEX_ARGS, codexChildEnvironment, getCodexExecutable } from "./codex-config";

export type CodexObject = Record<string, unknown>;
export function object(value: unknown): CodexObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as CodexObject : {};
}
export interface CodexFrame extends CodexObject { id?: string | number; method?: string; params?: CodexObject; }
export interface CodexTransport {
  start(): Promise<void>;
  request(method: string, params: CodexObject): Promise<CodexObject>;
  respond(id: string | number, result: CodexObject): void;
  reject(id: string | number, message: string): void;
  onFrame(callback: (frame: CodexFrame) => void): void;
  onClose(callback: (reason: Error) => void): void;
  destroy(): void;
}

type CodexLaunchOptions = { experimentalApi?: boolean; executable?: string; env?: NodeJS.ProcessEnv };

/** Codex app-server JSON-RPC. It never enters the OMP/Pi RPC decoder. */
export class CodexRpcClient implements CodexTransport {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private pending = new Map<string, { resolve: (result: CodexObject) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listener: (frame: CodexFrame) => void = () => {};
  private closedListener: (error: Error) => void = () => {};
  private closed = false;
  private launch?: { executable: string; env: NodeJS.ProcessEnv };
  constructor(private readonly cwd: string, private readonly spawnProcess: typeof spawn = spawn, private readonly options: CodexLaunchOptions = {}) {}
  onFrame(callback: (frame: CodexFrame) => void): void { this.listener = callback; }
  onClose(callback: (reason: Error) => void): void { this.closedListener = callback; }
  /** Reuse the actual native launch identity, with a separate JSON-RPC/event stream. */
  createTitleClient(): CodexTransport {
    if (!this.launch || this.closed) throw new Error("Codex title transport requires a running native session");
    return new CodexRpcClient(this.cwd, this.spawnProcess, { ...this.launch, experimentalApi: true });
  }

  async start(): Promise<void> {
    if (this.child || this.closed) throw new Error("Codex transport cannot be started twice");
    this.launch = { executable: this.options.executable ?? getCodexExecutable(), env: this.options.env ?? codexChildEnvironment() };
    this.child = this.spawnProcess(this.launch.executable, CODEX_ARGS, {
      cwd: this.cwd, env: this.launch.env, shell: false, detached: process.platform !== "win32", stdio: "pipe",
    }) as ChildProcessWithoutNullStreams;
    this.child.on("error", (e) => this.fail(new Error(`Cannot start Codex CLI: ${e.message}`)));
    this.child.on("close", (code) => this.fail(new Error(`Codex app-server exited (${code ?? "signal"})`)));
    this.child.stderr.resume(); // Drain, but never expose raw auth diagnostics in the web transcript.
    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        let lf: number;
        while ((lf = this.buffer.indexOf(10)) !== -1) {
          if (lf > 64 * 1024 * 1024) throw new Error("Codex RPC line is too large");
          const line = this.buffer.subarray(0, lf); this.buffer = this.buffer.subarray(lf + 1);
          if (!line.length) continue;
          const frame = object(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(line))) as CodexFrame;
          if (typeof frame.method === "string") {
            // Server requests have their own IDs; never confuse them with responses.
            this.listener(frame);
          } else if (typeof frame.id === "string" && this.pending.has(frame.id)) {
            const wait = this.pending.get(frame.id)!; this.pending.delete(frame.id); clearTimeout(wait.timer);
            if (frame.error) wait.reject(new Error(String(object(frame.error).message || "Codex request failed")));
            else wait.resolve(object(frame.result));
          }
        }
        if (this.buffer.length > 64 * 1024 * 1024) throw new Error("Unterminated Codex RPC line is too large");
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
    this.child.stdout.on("end", () => this.fail(new Error(this.buffer.length ? "Incomplete Codex RPC record" : "Codex RPC stream ended")));
    try {
      await this.request("initialize", { clientInfo: { name: "omp_web", title: "OMP Web", version: "0.1.0" }, capabilities: { experimentalApi: this.options.experimentalApi ?? false, requestAttestation: false } });
      this.write({ method: "initialized", params: {} });
    } catch (error) { this.destroy(); throw error; }
  }
  private write(frame: CodexObject): void {
    if (this.closed || !this.child?.stdin.writable) throw new Error("Codex transport is closed");
    const line = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(line) > 64 * 1024 * 1024) throw new Error("Codex request is too large (64 MiB limit)");
    this.child.stdin.write(line, (error) => { if (error) this.fail(error); });
  }
  request(method: string, params: CodexObject): Promise<CodexObject> {
    if (this.closed) return Promise.reject(new Error("Codex transport is closed"));
    const id = `web-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`Codex ${method} timed out; request was not retried`)), 60_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  respond(id: string | number, result: CodexObject): void { if (!this.closed) this.write({ id, result }); }
  reject(id: string | number, message: string): void { if (!this.closed) this.write({ id, error: { code: -32601, message } }); }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const wait of this.pending.values()) { clearTimeout(wait.timer); wait.reject(error); }
    this.pending.clear();
    const child = this.child;
    const kill = (signal: NodeJS.Signals) => {
      if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
      try { if (process.platform === "win32") child.kill(signal); else process.kill(-child.pid, signal); } catch { /* Exited. */ }
    };
    kill("SIGTERM");
    const timer = setTimeout(() => kill("SIGKILL"), 2000); timer.unref();
    child?.once("close", () => clearTimeout(timer));
    try { this.closedListener(error); } catch { /* Cleanup must still reject callers and terminate the child. */ }
  }
  destroy(): void { this.fail(new Error("Codex session closed")); }
}

/** Safe replies for unrendered/native requests; never grant persistent permissions. */
export function denyCodexRequest(client: CodexTransport, frame: CodexFrame): void {
  if (frame.id === undefined) return;
  if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(frame.method || "")) client.respond(frame.id, { decision: "cancel" });
  else if (frame.method === "item/permissions/requestApproval") client.respond(frame.id, { permissions: {}, scope: "turn" });
  else if (frame.method === "item/tool/requestUserInput") client.respond(frame.id, { answers: {} });
  else if (frame.method === "mcpServer/elicitation/request") client.respond(frame.id, { action: "decline" });
  else client.reject(frame.id, "This request is not supported by the web UI");
}

export async function listCodexModels(client: CodexTransport): Promise<CodexObject[]> {
  const models: CodexObject[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await client.request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result.data)) throw new Error("Invalid Codex model catalog");
    models.push(...result.data.map(object).filter((m) => typeof m.model === "string" && !m.hidden));
    if (result.nextCursor == null) return models;
    if (typeof result.nextCursor !== "string" || seen.has(result.nextCursor)) throw new Error("Invalid Codex catalog pagination");
    cursor = result.nextCursor; seen.add(cursor);
  }
  throw new Error("Codex model catalog exceeded pagination limit");
}
