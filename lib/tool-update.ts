import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import lockfile from "proper-lockfile";
import { readToolInstalledVersion } from "./tool-version";
import { discoverAgent } from "./agent-executable";
import { resolveToolUpdatePlan, updateEnvironment, validToolVersion, type ToolUpdatePlan } from "./tool-update-plan";
import { isUpdatableTool, TOOL_IDS, TOOL_LABELS, type ToolUpdatesSnapshot, type ToolUpdateStatus, type UpdatableTool } from "./tool-update-types";

const exec = promisify(execFile);
const SERVICE = "omp-web.service";
const SYSTEMCTL = "/usr/bin/systemctl";
const MAX_OUTPUT = 16_384;
const UPDATE_TIMEOUT = 20 * 60_000;
type Job = Omit<ToolUpdateStatus, "available" | "unavailableReason"> & { invocation: string; pid: number };

declare global {
  var __ompWebToolUpdateStarting: boolean | undefined;
  var __ompWebToolUpdateJob: Job | undefined;
}

export class ToolUpdateError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function statePath(): string {
  // Retain the original OMP job/lock location for old tabs and unfinished jobs.
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "omp-web", "omp-update.json");
}

function unavailableReason(): string | undefined {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || !process.env.INVOCATION_ID) {
    return "Updates require the root-owned systemd omp-web.service on Linux.";
  }
  try {
    const cgroups = readFileSync("/proc/self/cgroup", "utf8");
    if (!cgroups.split("\n").some((line) => line.split(":").slice(2).join(":").split("/").includes(SERVICE))) {
      return "This web process is not running inside omp-web.service.";
    }
    accessSync(SYSTEMCTL, constants.X_OK);
  } catch {
    return "Cannot verify systemd service membership or access systemctl.";
  }
}

function readJob(): Job | undefined {
  if (globalThis.__ompWebToolUpdateJob) return globalThis.__ompWebToolUpdateJob;
  let text: string;
  try { text = readFileSync(statePath(), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const value = JSON.parse(text) as Job;
  if (!value || !["updating", "restarting", "succeeded", "failed"].includes(value.phase)
    || typeof value.id !== "string" || typeof value.invocation !== "string"
    || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.output !== "string"
    || (value.tool !== undefined && !isUpdatableTool(value.tool))) {
    throw new Error("Invalid software update state file; inspect it before starting another update.");
  }
  return { ...value, tool: value.tool ?? "omp" };
}

function ownerAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function observedJob(job: Job | undefined, reason: string | undefined): Omit<ToolUpdateStatus, "available"> | undefined {
  if (!job) return undefined;
  const { invocation, pid, ...status } = job;
  const newInvocation = Boolean(process.env.INVOCATION_ID && process.env.INVOCATION_ID !== invocation);
  // A disconnected browser or queued restart is not a successful update.
  if (!reason && status.phase === "restarting" && newInvocation) status.phase = "succeeded";
  else if (status.phase === "updating" && (newInvocation || !ownerAlive(pid))) {
    status.phase = "failed";
    status.error = "The web process stopped during the update. Inspect the installation before retrying; no automatic retry was performed.";
  }
  return status;
}

/** Coordinator snapshot only: no subprocesses. GET enriches its version separately. */
export function getToolUpdates(): ToolUpdatesSnapshot {
  const reason = unavailableReason();
  const job = observedJob(readJob(), reason);
  const tools = TOOL_IDS.map((tool): ToolUpdateStatus => {
    let plan: ToolUpdatePlan | undefined;
    let toolReason = reason;
    try { plan = resolveToolUpdatePlan(tool); }
    catch (error) { toolReason ??= error instanceof Error ? error.message : String(error); }
    return {
      tool, phase: "idle", output: "",
      ...(job?.tool === tool ? job : {}),
      available: !toolReason, unavailableReason: toolReason,
      executable: plan?.executable ?? discoverAgent(tool).executable, installedVersion: plan?.installedVersion,
    };
  });
  return { tools, job: job ? tools.find((tool) => tool.tool === job.tool)! : null };
}

/** Read-only native --version when metadata is unavailable; never installs anything. */
export async function getToolUpdateView(): Promise<ToolUpdatesSnapshot> {
  const snapshot = getToolUpdates();
  await Promise.all(snapshot.tools.map(async (tool) => {
    if (tool.phase === "updating" || tool.phase === "restarting" || !tool.executable || tool.installedVersion) return;
    Object.assign(tool, await readToolInstalledVersion({ tool: tool.tool, executable: tool.executable, command: tool.executable, args: [] }));
  }));
  return snapshot;
}

function saveJob(job: Job): void {
  const path = statePath();
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(job), { mode: 0o600 });
  renameSync(temporary, path);
}

async function version(plan: ToolUpdatePlan, env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await exec(plan.executable, ["--version"], { env, cwd: homedir(), timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 65_536 });
  const value = stripVTControlCharacters(stdout).trim();
  if (!validToolVersion(plan.tool, value)) throw new Error(`${TOOL_LABELS[plan.tool]} returned an unrecognized version; automatic restart was cancelled.`);
  return value;
}

async function runUpdate(plan: ToolUpdatePlan, env: NodeJS.ProcessEnv, job: Job, assertLock: () => void): Promise<void> {
  const { promise, resolve: resolveUpdate, reject } = Promise.withResolvers<void>();
  const child = spawn(plan.command, plan.args, { env, cwd: homedir(), shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let failure: Error | undefined;
  let dirty = false;
  const terminate = () => {
    if (!child.pid) return;
    // Do not leave a downloader/package manager running after releasing its lock.
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
  };
  const append = (text: string) => {
    job.output = (job.output + stripVTControlCharacters(text)).slice(-MAX_OUTPUT);
    dirty = true;
  };
  child.stdout.setEncoding("utf8").on("data", append);
  child.stderr.setEncoding("utf8").on("data", append);
  const flush = setInterval(() => {
    if (failure) return;
    try { assertLock(); if (dirty) { saveJob(job); dirty = false; } }
    catch (error) { failure = error instanceof Error ? error : new Error(String(error)); terminate(); }
  }, 1_000);
  const timeout = setTimeout(() => {
    failure = new Error("Update exceeded 20 minutes; stopped without restarting the web service.");
    terminate();
  }, UPDATE_TIMEOUT);
  child.once("error", (error) => { failure = error; });
  child.once("close", (code, signal) => {
    clearInterval(flush);
    clearTimeout(timeout);
    if (failure) reject(failure);
    else if (code !== 0) reject(new Error(`Update failed (${signal || `exit ${code}`}); the web service was not restarted.`));
    else resolveUpdate();
  });
  return promise;
}

async function performUpdate(plan: ToolUpdatePlan, job: Job, release: () => Promise<void>, assertLock: () => void): Promise<void> {
  try {
    const env = updateEnvironment(plan);
    job.previousVersion = await version(plan, env);
    assertLock(); saveJob(job);
    await runUpdate(plan, env, job, assertLock);
    assertLock();
    // Recheck the selected launcher after install; never validate another CLI.
    job.currentVersion = await version(plan, env);
    job.phase = "restarting";
    assertLock(); saveJob(job);
    await exec(SYSTEMCTL, ["--system", "--no-ask-password", "--no-block", "restart", SERVICE], { timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 65_536 });
  } catch (error) {
    job.phase = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    job.finishedAt = new Date().toISOString();
    try { assertLock(); saveJob(job); } catch (saveError) { console.error("Could not persist software update failure", saveError); }
  } finally {
    try { await release(); } catch (error) { console.error("Could not release software update lock", error); }
    globalThis.__ompWebToolUpdateStarting = false;
  }
}

export async function startToolUpdate(tool: UpdatableTool): Promise<ToolUpdatesSnapshot> {
  if (!isUpdatableTool(tool)) throw new ToolUpdateError("Unknown software update target.", 400);
  if (globalThis.__ompWebToolUpdateStarting) throw new ToolUpdateError("Another software update is already running.", 409);
  globalThis.__ompWebToolUpdateStarting = true;
  let release: (() => Promise<void>) | undefined;
  let handedOff = false;
  try {
    const reason = unavailableReason();
    if (reason) throw new ToolUpdateError(reason, 503);
    mkdirSync(dirname(statePath()), { recursive: true, mode: 0o700 });
    let lockError: Error | undefined;
    try {
      release = await lockfile.lock(statePath(), { realpath: false, retries: 0, stale: 30_000, onCompromised: (error) => { lockError = error; } });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new ToolUpdateError("Another software update owns the lock.", 409);
      throw error;
    }
    const current = observedJob(readJob(), reason);
    if (current?.phase === "updating" || current?.phase === "restarting") throw new ToolUpdateError("An update or service restart is already running.", 409);
    let plan: ToolUpdatePlan;
    try { plan = resolveToolUpdatePlan(tool); }
    catch (error) { throw new ToolUpdateError(error instanceof Error ? error.message : String(error), 503); }
    const { stdout } = await exec(SYSTEMCTL, ["--system", "--no-ask-password", "show", SERVICE, "--property=InvocationID", "--value"], { timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 65_536 });
    if (stdout.trim() !== process.env.INVOCATION_ID) throw new ToolUpdateError("Refusing to restart a different systemd service instance.", 503);
    if (lockError) throw lockError;
    const job: Job = { tool, id: randomUUID(), phase: "updating", startedAt: new Date().toISOString(), output: "", invocation: process.env.INVOCATION_ID!, pid: process.pid };
    saveJob(job);
    globalThis.__ompWebToolUpdateJob = job;
    handedOff = true;
    void performUpdate(plan, job, release, () => { if (lockError) throw lockError; });
    return getToolUpdates();
  } finally {
    if (!handedOff) {
      globalThis.__ompWebToolUpdateStarting = false;
      await release?.();
    }
  }
}
