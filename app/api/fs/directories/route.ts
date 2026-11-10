import { NextResponse } from "next/server";
import { readdirSync, statSync, mkdirSync, existsSync, type Stats } from "fs";
import { homedir, platform } from "os";
import { join, dirname, isAbsolute, resolve } from "path";
import { folderNameError } from "@/lib/directory-browser";
import { allowFileRoot } from "@/lib/file-access";

function getWindowsDrives(): string[] {
  if (platform() !== "win32") return [];
  const drives: string[] = [];
  for (let i = 67; i <= 90; i++) { // C to Z
    const drive = `${String.fromCharCode(i)}:\\`;
    try {
      if (existsSync(drive)) drives.push(drive);
    } catch {
      // ignore unreadable drives
    }
  }
  return drives;
}

function normalizePath(inputPath?: string | null): string {
  if (!inputPath || !inputPath.trim()) return homedir();
  let p = inputPath.trim();
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    p = join(homedir(), p.slice(1));
  }
  if (!isAbsolute(p)) p = resolve(p);
  return p;
}

// GET /api/fs/directories?path=...
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const rawPath = searchParams.get("path");
    const targetPath = normalizePath(rawPath);

    if (!existsSync(targetPath)) {
      return NextResponse.json({ error: `Directory does not exist: ${targetPath}` }, { status: 404 });
    }

    const stat = statSync(targetPath);
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: `Path is not a directory: ${targetPath}` }, { status: 400 });
    }

    const drives = getWindowsDrives();
    const parentPath = dirname(targetPath) !== targetPath ? dirname(targetPath) : null;

    const entries: Array<{ name: string; path: string; modified?: string }> = [];
    try {
      const dirents = readdirSync(targetPath, { withFileTypes: true });
      for (const dirent of dirents) {
        if (!dirent.isDirectory()) continue;
        const name = dirent.name;
        // Skip system/hidden system folders on Windows/Unix
        if (name === "$RECYCLE.BIN" || name === "System Volume Information" || name === "DumpStack.log.tmp") continue;

        const fullPath = join(targetPath, name);
        let modified: string | undefined;
        try {
          const s = statSync(fullPath);
          modified = s.mtime.toISOString();
        } catch {
          // ignore unreadable subfolders
        }
        entries.push({ name, path: fullPath, modified });
      }
    } catch (e) {
      return NextResponse.json({ error: `Failed to read directory: ${e instanceof Error ? e.message : String(e)}` }, { status: 403 });
    }

    // Sort subdirectories alphabetically
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

    return NextResponse.json({
      currentPath: targetPath,
      parentPath,
      homeDir: homedir(),
      drives,
      directories: entries,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/fs/directories — create one new folder directly inside an existing directory
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { parentPath?: unknown; folderName?: unknown };
    const parentPath = normalizePath(typeof body.parentPath === "string" ? body.parentPath : null);
    const folderName = typeof body.folderName === "string" ? body.folderName.trim() : "";

    const nameError = folderNameError(folderName);
    if (nameError) {
      return NextResponse.json({ error: nameError }, { status: 400 });
    }

    let parentStat: Stats;
    try {
      parentStat = statSync(parentPath);
    } catch {
      return NextResponse.json({ error: `Directory does not exist: ${parentPath}` }, { status: 404 });
    }
    if (!parentStat.isDirectory()) {
      return NextResponse.json({ error: `Path is not a directory: ${parentPath}` }, { status: 400 });
    }

    const newPath = join(parentPath, folderName);
    try {
      mkdirSync(newPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return NextResponse.json({ error: `Folder already exists: ${newPath}` }, { status: 409 });
      }
      throw error;
    }
    allowFileRoot(newPath);

    return NextResponse.json({ success: true, path: newPath });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
