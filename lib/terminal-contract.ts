// Shared wire format; keep this module free of Node/browser dependencies.
export const TERMINAL_MAX_INPUT = 16_384;
export const TERMINAL_MAX_BODY = 128 * 1024;

export interface TerminalSize { cols: number; rows: number }
export interface TerminalInfo {
  id: string;
  cwd: string;
  pid: number;
  alive: boolean;
  /** Executable actually started, and whether it runs as a login shell. */
  shell: string;
  login: boolean;
}

/** Browser preference for new terminals. No `shell` means the server default. */
export interface TerminalLaunch { shell?: string; login?: boolean }
export interface TerminalShellOption {
  path: string;
  name: string;
  /** Whether the shell accepts `-l` (start as a login shell, like SSH). */
  login: boolean;
}
export interface TerminalShellCatalog {
  shells: TerminalShellOption[];
  /** The shell used when the browser leaves the choice on automatic. */
  defaultShell: TerminalShellOption;
}
export type TerminalEvent =
  | { type: "output"; seq: number; data: string }
  | { type: "exit"; seq: number; exitCode: number }
  | { type: "reset" }
  | { type: "ready"; terminal: TerminalInfo };

export function isTerminalId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isTerminalSize(value: unknown): value is TerminalSize {
  if (!value || typeof value !== "object") return false;
  const { cols, rows } = value as Partial<TerminalSize>;
  return Number.isInteger(cols) && Number.isInteger(rows)
    && cols! >= 2 && cols! <= 500 && rows! >= 2 && rows! <= 300;
}
