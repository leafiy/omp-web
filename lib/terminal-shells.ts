import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import type { TerminalLaunch, TerminalShellCatalog, TerminalShellOption } from "./terminal-contract";

// Shells that accept `-l` to start as a login shell, as an SSH session does.
const LOGIN_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "ash", "yash"]);
// Account placeholders (service users) that refuse interactive sessions.
const NOT_SHELLS = new Set(["nologin", "false"]);

/** Host facts used to pick a shell; injectable for tests. */
export interface ShellHost {
  platform: NodeJS.Platform;
  envShell(): string | undefined;
  accountShell(): string | undefined;
  shellsFile(): string;
  /** Real path of an executable regular file, or undefined. */
  executable(file: string): string | undefined;
}

export interface TerminalLaunchPlan { shell: string; args: string[]; login: boolean }

const nodeHost: ShellHost = {
  platform: process.platform,
  envShell: () => process.env.SHELL,
  accountShell: () => { try { return userInfo().shell ?? undefined; } catch { return undefined; } },
  shellsFile: () => { try { return readFileSync("/etc/shells", "utf8"); } catch { return ""; } },
  executable: (file) => {
    try {
      const real = realpathSync(file);
      if (!statSync(real).isFile()) return undefined;
      accessSync(real, constants.X_OK);
      return real;
    } catch { return undefined; }
  },
};

function shellOption(file: string, real: string): TerminalShellOption {
  // `/bin/sh` may be dash: either name qualifies it for `-l`.
  const login = LOGIN_SHELLS.has(path.basename(file)) || LOGIN_SHELLS.has(path.basename(real));
  return { path: file, name: path.basename(file), login };
}

/** Installed shells from /etc/shells, deduplicated by real executable. */
export function listTerminalShells(host: ShellHost = nodeHost): TerminalShellOption[] {
  if (host.platform === "win32") return [];
  const seen = new Set<string>();
  const shells: TerminalShellOption[] = [];
  for (const line of host.shellsFile().split("\n")) {
    const file = line.trim();
    if (!path.isAbsolute(file)) continue; // blank lines and comments
    const real = host.executable(file);
    if (!real || seen.has(real) || NOT_SHELLS.has(path.basename(real))) continue;
    seen.add(real);
    shells.push(shellOption(file, real));
  }
  return shells;
}

/** Automatic choice: `$SHELL`, then the account's login shell, then bash/sh. */
export function defaultTerminalShell(host: ShellHost = nodeHost): TerminalShellOption {
  if (host.platform === "win32") return { path: "powershell.exe", name: "powershell.exe", login: false };
  for (const file of [host.envShell(), host.accountShell(), "/bin/bash", "/bin/sh"]) {
    if (!file || !path.isAbsolute(file)) continue;
    const real = host.executable(file);
    if (real && !NOT_SHELLS.has(path.basename(real))) return shellOption(file, real);
  }
  return shellOption("/bin/sh", "/bin/sh");
}

export function terminalShellCatalog(host: ShellHost = nodeHost): TerminalShellCatalog {
  return { shells: listTerminalShells(host), defaultShell: defaultTerminalShell(host) };
}

export function defaultTerminalLaunch(host: ShellHost = nodeHost): TerminalLaunchPlan {
  return { shell: defaultTerminalShell(host).path, args: [], login: false };
}

/**
 * Turns a browser preference into an executable plan. A named shell must be
 * listed in /etc/shells: the browser never selects an arbitrary program.
 * Returns null for an unlisted shell. `-l` is applied only where supported;
 * the plan reports whether it was.
 */
export function resolveTerminalLaunch(choice: TerminalLaunch, host: ShellHost = nodeHost): TerminalLaunchPlan | null {
  const selected = choice.shell === undefined
    ? defaultTerminalShell(host)
    : listTerminalShells(host).find((shell) => shell.path === choice.shell);
  if (!selected) return null;
  const login = choice.login === true && selected.login;
  return { shell: selected.path, args: login ? ["-l"] : [], login };
}
