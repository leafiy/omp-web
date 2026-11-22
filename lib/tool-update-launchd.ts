import { execFileSync } from "node:child_process";

const LABEL = "io.github.leafiy.omp-web";
export const LAUNCHCTL = "/bin/launchctl";
export const launchdTarget = () => `gui/${process.getuid!()}/${LABEL}`;

// install.sh registers bin/omp-web.js as the job; it spawns the Next server.
// Key the persisted identity to the supervisor's PID, not a bundle/module load.
export function launchdInvocation(): string {
  return `launchd:${launchdTarget()}:${process.ppid}`;
}

let verified: { invocation: string; until: number } | undefined;
export function launchdUnavailable(fresh = false): string | undefined {
  if (!process.getuid?.() || process.ppid <= 1) return "Updates require the per-user omp-web LaunchAgent on macOS.";
  const invocation = launchdInvocation();
  if (!fresh && verified?.invocation === invocation && verified.until > Date.now()) return;
  verified = undefined;
  try {
    // Never surface print's output/errors: job details can contain environment values.
    const state = execFileSync(LAUNCHCTL, ["print", launchdTarget()], { encoding: "utf8", timeout: 2000, maxBuffer: 131072, stdio: ["ignore", "pipe", "ignore"] });
    if (/^\tpid = (\d+)$/m.exec(state)?.[1] === String(process.ppid)) {
      verified = { invocation, until: Date.now() + 30_000 };
      return;
    }
  } catch { /* Fail closed. */ }
  return "Cannot verify that this web process belongs to the omp-web LaunchAgent.";
}
