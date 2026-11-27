import { randomBytes } from "node:crypto";
import path from "node:path";
import { HTML_PREVIEW_SANDBOX } from "./file-types";

/**
 * Rendered previews of project HTML files.
 *
 * The file viewer frames `/html-preview/<token>/<path below the grant root>`,
 * so relative CSS, scripts, images and links resolve like a local static
 * server. The page runs in a sandbox without `allow-same-origin`: its opaque
 * origin cannot reach omp-web's APIs, storage or login cookie. Its own asset
 * requests carry no cookie either (SameSite=Lax), so the unguessable token is
 * the credential: minted by an authenticated `/api/files` request, read-only,
 * scoped to one directory tree, limited to web asset types, and expiring when
 * idle. The route lives outside `/api` because the proxy rejects the
 * cross-site requests an opaque origin makes; it checks the Host itself.
 */

export const HTML_PREVIEW_PATH = "/html-preview";

const GRANT_IDLE_MS = 60 * 60_000;
const MAX_GRANTS = 256;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

export interface HtmlPreviewGrant {
  /** Directory tree whose web assets the page may load. */
  root: string;
  /** The previewed file, as requested (below `root`). */
  entry: string;
  /** Real path of the previewed file when the grant was minted. */
  entryReal: string;
  expiresAt: number;
}

declare global {
  var __ompWebHtmlPreviewGrants: Map<string, HtmlPreviewGrant> | undefined;
}

function grants(): Map<string, HtmlPreviewGrant> {
  return globalThis.__ompWebHtmlPreviewGrants ??= new Map();
}

const HTML_DOCUMENT_EXTS = new Set(["html", "htm", "xhtml"]);

const PREVIEW_EXT_TO_MIME: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  xhtml: "application/xhtml+xml",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  apng: "image/apng",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mov: "video/quicktime",
  vtt: "text/vtt",
};

function extensionOf(filePath: string): string {
  const name = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Files the viewer renders as a page rather than showing their source only. */
export function isHtmlPreviewPath(filePath: string): boolean {
  return HTML_DOCUMENT_EXTS.has(extensionOf(filePath));
}

/** Web asset MIME type the preview may serve; null refuses the file. */
export function htmlPreviewMime(filePath: string): string | null {
  const ext = extensionOf(filePath);
  return Object.prototype.hasOwnProperty.call(PREVIEW_EXT_TO_MIME, ext) ? PREVIEW_EXT_TO_MIME[ext] : null;
}

/**
 * Text responses default to UTF-8. An HTML file that declares its own encoding
 * (BOM or `<meta charset>` near the top) keeps it, as a browser opening the
 * file directly would.
 */
export function htmlPreviewContentType(mime: string, head: Uint8Array): string {
  const isText = mime.startsWith("text/") || mime === "application/xhtml+xml";
  if (!isText) return mime;
  if (mime === "text/html" || mime === "application/xhtml+xml") {
    const hasBom = (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf)
      || (head[0] === 0xfe && head[1] === 0xff)
      || (head[0] === 0xff && head[1] === 0xfe);
    const prefix = Buffer.from(head).toString("latin1");
    if (hasBom || /<meta[^>]+charset\s*=/i.test(prefix) || /<\?xml[^>]+encoding\s*=/i.test(prefix)) return mime;
  }
  return `${mime}; charset=utf-8`;
}

/** Response headers for a served preview file; documents get the CSP sandbox too. */
export function htmlPreviewHeaders(mime: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  };
  // Also applies if the URL is opened directly, outside the viewer's iframe.
  if (mime === "text/html" || mime === "application/xhtml+xml") headers["Content-Security-Policy"] = `sandbox ${HTML_PREVIEW_SANDBOX}`;
  return headers;
}

function prune(map: Map<string, HtmlPreviewGrant>, now: number): void {
  for (const [token, grant] of map) if (grant.expiresAt <= now) map.delete(token);
}

/** Mint (or reuse) a grant for one HTML file; returns the frame URL. */
export function createHtmlPreviewUrl(
  entry: string,
  entryReal: string,
  root: string,
  now = Date.now(),
): string {
  const resolvedRoot = path.resolve(root);
  const resolvedEntry = path.resolve(entry);
  const relative = path.relative(resolvedRoot, resolvedEntry);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Preview root must contain the previewed file");
  }

  const map = grants();
  prune(map, now);
  let token: string | undefined;
  for (const [candidate, grant] of map) {
    if (grant.root === resolvedRoot && grant.entry === resolvedEntry && grant.entryReal === entryReal) {
      token = candidate;
      break;
    }
  }
  if (token) {
    const grant = map.get(token)!;
    map.delete(token);
    map.set(token, { ...grant, expiresAt: now + GRANT_IDLE_MS });
  } else {
    while (map.size >= MAX_GRANTS) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
    token = randomBytes(24).toString("base64url");
    map.set(token, { root: resolvedRoot, entry: resolvedEntry, entryReal, expiresAt: now + GRANT_IDLE_MS });
  }
  return `${HTML_PREVIEW_PATH}/${token}/${relative.split(path.sep).map(encodeURIComponent).join("/")}`;
}

/** Valid grant for a token, extending its idle expiry; null when unknown or expired. */
export function resolveHtmlPreviewGrant(token: string, now = Date.now()): HtmlPreviewGrant | null {
  if (!TOKEN_RE.test(token)) return null;
  const map = grants();
  const grant = map.get(token);
  if (!grant) return null;
  map.delete(token);
  if (grant.expiresAt <= now) return null;
  const refreshed = { ...grant, expiresAt: now + GRANT_IDLE_MS };
  map.set(token, refreshed);
  return refreshed;
}

function escapes(relative: string): boolean {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/**
 * Map decoded URL segments to a path below the grant root, or null. Hidden
 * names (`.git`, `.env`, …) are refused unless they belong to the previewed
 * file's own directory path. Symlinks and allow-list roots are checked by the
 * caller against the real file system.
 */
export function resolveHtmlPreviewTarget(grant: HtmlPreviewGrant, segments: string[]): string | null {
  if (!segments.length || segments.some((segment) => !segment || segment.includes("\0") || /[\\/]/.test(segment))) return null;
  const target = path.resolve(grant.root, ...segments);
  if (target === grant.entry) return target;
  const fromRoot = path.relative(grant.root, target);
  if (!fromRoot || escapes(fromRoot)) return null;
  const fromEntryDir = path.relative(path.dirname(grant.entry), target);
  const checked = escapes(fromEntryDir) ? fromRoot : fromEntryDir;
  if (checked.split(path.sep).some((part) => part.startsWith("."))) return null;
  return target;
}
