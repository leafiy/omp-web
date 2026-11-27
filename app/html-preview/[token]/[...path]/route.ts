import fs from "fs";
import type { NextRequest } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { streamFile } from "@/lib/file-stream";
import {
  htmlPreviewContentType,
  htmlPreviewHeaders,
  htmlPreviewMime,
  resolveHtmlPreviewGrant,
  resolveHtmlPreviewTarget,
} from "@/lib/html-preview";
import { isExistingPathWithinRoots } from "@/lib/path-security";
import { isApiRequestHostAllowed } from "@/lib/request-security";

// Sandboxed HTML file previews. See lib/html-preview.ts: the proxy does not
// match this path (the page's opaque origin sends cross-site requests without
// the login cookie), so this route checks the Host and the grant token itself.
export const dynamic = "force-dynamic";

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function readHead(filePath: string): Uint8Array {
  const head = Buffer.alloc(1024);
  const fd = fs.openSync(filePath, "r");
  try {
    return head.subarray(0, fs.readSync(fd, head, 0, head.length, 0));
  } finally {
    fs.closeSync(fd);
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; path: string[] }> },
) {
  if (!isApiRequestHostAllowed(request)) return textResponse(403, "Untrusted request");
  const { token, path: segments } = await params;
  const grant = resolveHtmlPreviewGrant(token);
  if (!grant) return textResponse(404, "This preview has expired. Reopen the file in omp-web.");

  const target = resolveHtmlPreviewTarget(grant, segments ?? []);
  const mime = target ? htmlPreviewMime(target) : null;
  if (!target || !mime) return textResponse(404, "Not found");

  let stat: fs.Stats;
  let realTarget: string;
  try {
    stat = fs.statSync(target);
    realTarget = fs.realpathSync(target);
  } catch {
    return textResponse(404, "Not found");
  }
  if (!stat.isFile()) return textResponse(404, "Not found");

  // The previewed file was authorized when the grant was minted; every other
  // file must stay inside the grant root and the file browser's allow-list.
  if (realTarget !== grant.entryReal) {
    if (!isExistingPathWithinRoots(target, new Set([grant.root]))) return textResponse(404, "Not found");
    if (!isExistingFilePathAllowed(target, await getAllowedFileRoots())) return textResponse(404, "Not found");
  }

  let contentType = mime;
  if (mime.startsWith("text/") || mime === "application/xhtml+xml") {
    try {
      contentType = htmlPreviewContentType(mime, readHead(realTarget));
    } catch {
      return textResponse(404, "Not found");
    }
  }
  return streamFile(realTarget, stat, contentType, request.headers.get("range"), false, htmlPreviewHeaders(mime));
}
