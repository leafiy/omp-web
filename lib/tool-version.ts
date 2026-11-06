import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { promisify, stripVTControlCharacters } from "node:util";
import { updateEnvironment, validToolVersion, type ToolUpdatePlan } from "./tool-update-plan";
import type { ToolUpdateStatus } from "./tool-update-types";

const exec = promisify(execFile);
type VersionInfo = Pick<ToolUpdateStatus, "installedVersion" | "versionError">;
const failure = (): VersionInfo => ({ versionError: "Unable to read the installed tool version. Retry shortly." });

async function probe(plan: ToolUpdatePlan): Promise<string> {
  const { stdout } = await exec(plan.executable, ["--version"], {
    cwd: homedir(), env: updateEnvironment(plan), shell: false,
    timeout: 3000, killSignal: "SIGKILL", maxBuffer: 16_384,
  });
  return stdout;
}

/** One cache per process, keyed by the selected binary AND its current identity. */
export function createToolVersionReader(deps: { probe?: typeof probe; now?: () => number } = {}) {
  const read = deps.probe ?? probe, now = deps.now ?? Date.now;
  const cache = new Map<string, { expiresAt: number; promise: Promise<VersionInfo> }>();
  return async (plan: ToolUpdatePlan): Promise<VersionInfo> => {
    if (!["omp", "pi", "claude", "codex"].includes(plan.tool)) return failure();
    let key: string;
    try {
      const path = realpathSync(plan.executable), stat = statSync(path);
      key = [plan.tool, plan.executable, path, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join("\0");
    } catch { return failure(); }
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.promise;
    const entry = { expiresAt: Infinity, promise: Promise.resolve<VersionInfo>({}) };
    // Register the in-flight promise before executing, so simultaneous opens share it.
    entry.promise = Promise.resolve().then(async (): Promise<VersionInfo> => {
      try {
        const value = stripVTControlCharacters(await read(plan)).trim();
        if (!validToolVersion(plan.tool, value)) return failure();
        return { installedVersion: value.replace(/^omp\//, "").replace(/^codex-cli /, "").replace(/ \(Claude Code\)$/, "") };
      } catch { return failure(); } // Do not return raw stdout/stderr or child-process errors.
    }).then((info) => {
      entry.expiresAt = now() + (info.installedVersion ? 5 * 60_000 : 10_000);
      return info;
    });
    cache.set(key, entry);
    while (cache.size > 16) cache.delete(cache.keys().next().value!);
    return entry.promise;
  };
}

declare global { var __ompWebToolVersionReader: ReturnType<typeof createToolVersionReader> | undefined; }
export function readToolInstalledVersion(plan: ToolUpdatePlan): Promise<VersionInfo> {
  return (globalThis.__ompWebToolVersionReader ??= createToolVersionReader())(plan);
}
