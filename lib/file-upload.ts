import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";

export const UPLOAD_CONFLICT_STRATEGIES = ["error", "overwrite", "skip"] as const;
export type UploadConflictStrategy = typeof UPLOAD_CONFLICT_STRATEGIES[number];

const UPLOAD_CONFLICT_STRATEGY_SET = new Set<string>(UPLOAD_CONFLICT_STRATEGIES);

export interface UploadTargetInspection {
  conflicts: string[];
  nonReplaceable: string[];
}

export function parseUploadConflictStrategy(value: string | null): UploadConflictStrategy | null {
  const candidate = value ?? "error";
  return UPLOAD_CONFLICT_STRATEGY_SET.has(candidate)
    ? candidate as UploadConflictStrategy
    : null;
}

export function validateUploadFileNames(fileNames: string[]): string | null {
  if (fileNames.length === 0) return "No files selected";

  const seen = new Set<string>();
  for (const fileName of fileNames) {
    if (!fileName || fileName === "." || fileName === ".." || fileName.includes("\0")) {
      return `Invalid file name: ${fileName || "(empty)"}`;
    }
    if (fileName.includes("/") || fileName.includes("\\") || path.basename(fileName) !== fileName) {
      return `File names must not contain a path: ${fileName}`;
    }
    if (seen.has(fileName)) return `Duplicate file name in upload: ${fileName}`;
    seen.add(fileName);
  }

  return null;
}

/** Keep the selected directory pinned while a multipart body arrives. */
export function pinUploadDirectory(directory: string) {
  const initial = fs.statSync(directory);
  const fd = process.platform === "linux" ? fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW) : undefined;
  const pinned = fd === undefined ? directory : `/proc/self/fd/${fd}`;
  const assertCurrent = () => {
    const current = fd === undefined ? fs.statSync(directory) : fs.fstatSync(fd);
    if (current.dev !== initial.dev || current.ino !== initial.ino || fs.realpathSync(pinned) !== directory) throw new Error("Upload directory changed; refresh and select it again");
  };
  try { assertCurrent(); } catch (error) { if (fd !== undefined) fs.closeSync(fd); throw error; }
  return { directory: pinned, assertCurrent, close: () => { if (fd !== undefined) fs.closeSync(fd); } };
}

/** Publish a complete file exclusively, or atomically replace an explicitly confirmed regular file. */
export function writeUploadFile(directory: string, name: string, bytes: Buffer, strategy: UploadConflictStrategy): "uploaded" | "skipped" {
  const destination = path.join(directory, name), temporary = path.join(directory, `.omp-web-upload-${randomUUID()}`);
  let existing: fs.Stats | undefined;
  try { existing = fs.lstatSync(destination); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing && strategy === "skip") return "skipped";
  if (existing && strategy !== "overwrite") throw new Error("File already exists");
  if (existing && !existing.isFile()) throw new Error("Cannot replace a directory or symbolic link");
  const fd = fs.openSync(temporary, "wx", existing ? existing.mode & 0o777 : 0o644);
  const identity = fs.fstatSync(fd);
  try {
    fs.writeFileSync(fd, bytes);
    if (existing) {
      const current = fs.lstatSync(destination);
      if (!current.isFile() || current.dev !== existing.dev || current.ino !== existing.ino || current.mtimeMs !== existing.mtimeMs || current.ctimeMs !== existing.ctimeMs) throw new Error("Upload target changed; refresh and confirm again");
      fs.renameSync(temporary, destination);
    } else {
      try { fs.linkSync(temporary, destination); }
      catch (error) { if (strategy === "skip" && (error as NodeJS.ErrnoException).code === "EEXIST") return "skipped"; throw error; }
    }
    return "uploaded";
  } finally {
    fs.closeSync(fd);
    try { const current = fs.lstatSync(temporary); if (current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export function inspectUploadTargets(directory: string, fileNames: string[]): UploadTargetInspection {
  const conflicts: string[] = [];
  const nonReplaceable: string[] = [];

  for (const fileName of fileNames) {
    const destination = path.join(directory, fileName);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw error;
    }

    conflicts.push(fileName);
    if (!stat.isFile() || stat.isSymbolicLink()) nonReplaceable.push(fileName);
  }

  return { conflicts, nonReplaceable };
}
