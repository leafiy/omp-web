import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { isPathWithinRoots } from "./path-security";
import type { FileOperationErrorCode, FileOperationRequest, FileOperationResult } from "./file-operation-types";

const MAX_ENTRIES = 10_000, MAX_COPY_BYTES = 512 * 1024 * 1024, MAX_DEPTH = 64;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

export class FileOperationError extends Error {
  constructor(public code: FileOperationErrorCode, public status: number, public partial = false) {
    super(code);
  }
}
const fail = (code: FileOperationErrorCode, status = 400): never => { throw new FileOperationError(code, status); };

/** Shared with listings. atime is deliberately excluded: previewing isn't an edit. */
export function fileEntryVersion(stat: Stats): string {
  return createHash("sha256").update([stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":")).digest("hex").slice(0, 32);
}
const sameEntry = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
const fdPath = (handle: FileHandle, name = "") => `/proc/self/fd/${handle.fd}${name ? `/${name}` : ""}`;
const within = (target: string, root: string) => isPathWithinRoots(target, new Set([root]));

export function parseFileOperation(value: unknown): FileOperationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("invalid");
  const v = value as Record<string, unknown>;
  if (!["copy", "move", "delete", "new-file", "new-directory"].includes(String(v.operation))) return fail("invalid");
  const operation = v.operation as FileOperationRequest["operation"];
  const absolute = (key: string): string => {
    const p = v[key];
    if (typeof p !== "string" || p.length > 4096 || !path.isAbsolute(p) || /[\x00-\x1f\x7f]/.test(p) || p.split(/[\\/]/).includes("..")) return fail("invalid");
    return path.resolve(p);
  };
  const source = ["copy", "move", "delete"].includes(operation) ? absolute("source") : undefined;
  const destination = operation !== "delete" ? absolute("destination") : undefined;
  if (source && (typeof v.sourceVersion !== "string" || !/^[a-f0-9]{32}$/.test(v.sourceVersion))) return fail("invalid");
  if (["move", "delete"].includes(operation) && v.confirm !== true) return fail("invalid");
  return { operation, source, destination, sourceVersion: source ? String(v.sourceVersion) : undefined, confirm: v.confirm === true };
}

/** Pin every directory component. Never traverse a link between checking and use. */
async function openDirectory(absolute: string, roots: Set<string>): Promise<FileHandle> {
  const root = [...roots].filter(r => within(absolute, r)).sort((a, b) => b.length - a.length)[0];
  if (!root) return fail("denied", 403);
  let handle = await fs.open(root, DIRECTORY_FLAGS);
  try {
    if (await fs.realpath(fdPath(handle)) !== root) return fail("changed", 409);
    const relative = path.relative(root, absolute);
    for (const name of relative.split(path.sep).filter(Boolean)) {
      const next = await fs.open(fdPath(handle, name), DIRECTORY_FLAGS);
      await handle.close(); handle = next;
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

interface Location { parent: FileHandle; name: string; absolute: string; }
async function locate(absolute: string, lexicalRoots: Set<string>, realRoots: Set<string>): Promise<Location> {
  if (!isPathWithinRoots(absolute, lexicalRoots)) return fail("denied", 403);
  const parentPath = await fs.realpath(path.dirname(absolute));
  if (!isPathWithinRoots(parentPath, realRoots)) return fail("denied", 403);
  const parent = await openDirectory(parentPath, realRoots);
  return { parent, name: path.basename(absolute), absolute: path.join(parentPath, path.basename(absolute)) };
}
async function stat(location: Location) { return fs.lstat(fdPath(location.parent, location.name)); }
async function exists(location: Location) {
  try { return await stat(location); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function verify(location: Location, before: Stats, version = true) {
  const now = await stat(location);
  if (!sameEntry(before, now) || version && fileEntryVersion(before) !== fileEntryVersion(now)) fail("changed", 409);
}

interface Manifest { name: string; stat: Stats; children?: Manifest[]; }
async function inspect(location: Location, budget: { entries: number; bytes: number }, copy: boolean, depth = 0): Promise<Manifest> {
  if (++budget.entries > MAX_ENTRIES || depth > MAX_DEPTH) return fail("too-large", 413);
  const before = await stat(location);
  if (!before.isFile() && !before.isDirectory() && !before.isSymbolicLink()) return fail("unsupported", 422);
  budget.bytes += before.isFile() ? before.size : 0;
  if (copy && budget.bytes > MAX_COPY_BYTES) return fail("too-large", 413);
  const result: Manifest = { name: location.name, stat: before };
  if (before.isDirectory()) {
    const dir = await fs.open(fdPath(location.parent, location.name), DIRECTORY_FLAGS);
    try {
      if (!sameEntry(before, await dir.stat())) return fail("changed", 409);
      result.children = [];
      for await (const child of await fs.opendir(fdPath(dir))) {
        const name = child.name;
        result.children.push(await inspect({ parent: dir, name, absolute: path.join(location.absolute, name) }, budget, copy, depth + 1));
      }
      await verify(location, before);
    } finally { await dir.close(); }
  }
  return result;
}

async function copyTree(source: Location, destination: Location, entry: Manifest, mutation: { started: boolean }) {
  await verify(source, entry.stat);
  if (entry.children) {
    await fs.mkdir(fdPath(destination.parent, destination.name), { mode: 0o700 }); mutation.started = true;
    const src = await fs.open(fdPath(source.parent, source.name), DIRECTORY_FLAGS);
    try {
      if (!sameEntry(entry.stat, await src.stat())) return fail("changed", 409);
      const dst = await fs.open(fdPath(destination.parent, destination.name), DIRECTORY_FLAGS);
      try {
        for (const child of entry.children) {
          await copyTree({ parent: src, name: child.name, absolute: path.join(source.absolute, child.name) },
            { parent: dst, name: child.name, absolute: path.join(destination.absolute, child.name) }, child, mutation);
        }
        await verify(source, entry.stat);
        await dst.chmod(entry.stat.mode & 0o777);
      } finally { await dst.close(); }
    } finally { await src.close(); }
  } else if (entry.stat.isSymbolicLink()) {
    const target = await fs.readlink(fdPath(source.parent, source.name));
    await verify(source, entry.stat);
    await fs.symlink(target, fdPath(destination.parent, destination.name)); mutation.started = true;
    await verify(source, entry.stat);
  } else {
    const src = await fs.open(fdPath(source.parent, source.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (fileEntryVersion(await src.stat()) !== fileEntryVersion(entry.stat)) return fail("changed", 409);
      const dst = await fs.open(fdPath(destination.parent, destination.name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, entry.stat.mode & 0o777);
      mutation.started = true;
      try {
        const buffer = Buffer.allocUnsafe(256 * 1024); let copied = 0;
        while (true) {
          const { bytesRead } = await src.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          copied += bytesRead; if (copied > entry.stat.size) return fail("changed", 409);
          let offset = 0;
          while (offset < bytesRead) { const { bytesWritten } = await dst.write(buffer, offset, bytesRead - offset, null); if (!bytesWritten) return fail("failed", 500); offset += bytesWritten; }
        }
        if (copied !== entry.stat.size || fileEntryVersion(await src.stat()) !== fileEntryVersion(entry.stat)) return fail("changed", 409);
        await verify(source, entry.stat);
      } finally { await dst.close(); }
    } finally { await src.close(); }
  }
}

async function deleteTree(location: Location, entry: Manifest, mutation: { started: boolean }) {
  await verify(location, entry.stat);
  if (entry.children) {
    const dir = await fs.open(fdPath(location.parent, location.name), DIRECTORY_FLAGS);
    try {
      if (!sameEntry(entry.stat, await dir.stat())) return fail("changed", 409);
      for (const child of entry.children) await deleteTree({ parent: dir, name: child.name, absolute: path.join(location.absolute, child.name) }, child, mutation);
      await verify(location, entry.stat, false);
      // rmdir, not recursive rm: a concurrently added file is never swept away.
      await fs.rmdir(fdPath(location.parent, location.name)); mutation.started = true;
    } finally { await dir.close(); }
  } else { await fs.unlink(fdPath(location.parent, location.name)); mutation.started = true; }
}

async function move(source: Location, destination: Location, before: Stats, mutation: { started: boolean }) {
  if (before.dev !== (await destination.parent.stat()).dev) return fail("unsupported", 422);
  await verify(source, before);
  if (before.isFile() || before.isSymbolicLink()) {
    // link is exclusive, unlike rename which silently overwrites another file.
    await fs.link(fdPath(source.parent, source.name), fdPath(destination.parent, destination.name)); mutation.started = true;
    const linked = await stat(destination), current = await stat(source);
    if (!sameEntry(before, linked) || !sameEntry(before, current) || current.mtimeMs !== before.mtimeMs || current.size !== before.size) return fail("changed", 409);
    await fs.unlink(fdPath(source.parent, source.name));
  } else if (before.isDirectory()) {
    // GNU mv uses renameat2(RENAME_NOREPLACE) on Linux. No shell, no user-supplied
    // executable/options, pinned parent FDs, same-filesystem only. No-clobber may
    // exit 0 without moving: verify identity rather than treating exit 0 as success.
    mutation.started = true;
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/mv", ["--no-clobber", "--no-target-directory", "--", `/proc/self/fd/3/${source.name}`, `/proc/self/fd/4/${destination.name}`],
        { cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C", NODE_ENV: process.env.NODE_ENV ?? "production" }, stdio: ["ignore", "ignore", "ignore", source.parent.fd, destination.parent.fd] });
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new FileOperationError("failed", 500, true)); });
    });
    const result = await exists(destination), remaining = await exists(source);
    if (!result || !sameEntry(result, before) || remaining && sameEntry(remaining, before)) return fail("changed", 409);
    mutation.started = true;
  } else return fail("unsupported", 422);
}

function mapError(error: unknown, partial: boolean): FileOperationError {
  if (error instanceof FileOperationError) { error.partial ||= partial; return error; }
  const code = (error as NodeJS.ErrnoException)?.code;
  const mapped: [FileOperationErrorCode, number] = code === "ENOENT" ? ["not-found", 404]
    : ["EEXIST", "ENOTEMPTY"].includes(code ?? "") ? ["conflict", 409]
    : ["ELOOP", "ENOTDIR", "EXDEV", "ENOSYS"].includes(code ?? "") ? ["unsupported", 422]
    : ["EACCES", "EPERM", "EROFS"].includes(code ?? "") ? ["denied", 403] : ["failed", 500];
  return new FileOperationError(...mapped, partial);
}

declare global { var __ompWebFileOperationBusy: boolean | undefined; }
/** One guarded mutation interface; roots are supplied by the existing authorization layer. */
export async function performFileOperation(value: unknown, allowedRoots: Set<string>): Promise<FileOperationResult> {
  const command = parseFileOperation(value);
  if (process.platform !== "linux") return fail("unsupported", 422);
  if (globalThis.__ompWebFileOperationBusy) return fail("busy", 409);
  globalThis.__ompWebFileOperationBusy = true;
  const opened: FileHandle[] = [], mutation = { started: false };
  try {
    const realRoots = new Set<string>();
    for (const root of allowedRoots) { try { realRoots.add(await fs.realpath(root)); } catch { /* stale root */ } }
    const { operation } = command;
    if (command.source && ["move", "delete"].includes(operation) && [...allowedRoots].some(root => within(root, command.source!))) return fail("protected", 403);
    const source = command.source ? await locate(command.source, allowedRoots, realRoots) : undefined;
    if (source) opened.push(source.parent);
    const destination = command.destination ? await locate(command.destination, allowedRoots, realRoots) : undefined;
    if (destination) opened.push(destination.parent);
    for (const location of [source, destination]) {
      if (location?.absolute.split(path.sep).includes(".git")) return fail("protected", 403);
    }
    if (source && ["move", "delete"].includes(operation) && [...realRoots].some(root => within(root, source.absolute))) return fail("protected", 403);
    if (destination && (await exists(destination) || [...realRoots].some(root => within(root, destination.absolute)))) return fail("conflict", 409);
    if (source && destination && within(destination.absolute, source.absolute)) return fail("invalid");
    if (source) {
      const before = await stat(source);
      if (fileEntryVersion(before) !== command.sourceVersion) return fail("changed", 409);
      if (!before.isFile() && !before.isDirectory() && !before.isSymbolicLink()) return fail("unsupported", 422);
      if (operation === "move") await move(source, destination!, before, mutation);
      else {
        const manifest = await inspect(source, { entries: 0, bytes: 0 }, operation === "copy");
        if (fileEntryVersion(manifest.stat) !== command.sourceVersion) return fail("changed", 409);
        if (operation === "copy") await copyTree(source, destination!, manifest, mutation);
        else await deleteTree(source, manifest, mutation);
      }
    } else if (operation === "new-directory") await fs.mkdir(fdPath(destination!.parent, destination!.name));
    else { const file = await fs.open(fdPath(destination!.parent, destination!.name), "wx", 0o644); await file.close(); }
    return { operation, source: command.source, destination: command.destination };
  } catch (error) { throw mapError(error, mutation.started); }
  finally {
    try { await Promise.all(opened.map(handle => handle.close())); }
    finally { globalThis.__ompWebFileOperationBusy = false; }
  }
}
