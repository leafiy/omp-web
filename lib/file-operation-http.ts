import { hasJsonContentType, isApiRequestAllowed } from "./request-security";
import { isRequestAuthenticated, webAuthRequired } from "./web-auth";
import { FileOperationError, parseFileOperation, performFileOperation } from "./file-operations";

const headers = { "Cache-Control": "private, no-store" };
export function guardFileMutation(request: Request): Response | undefined {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted request" }, { status: 403, headers });
  if (!isRequestAuthenticated(request)) return webAuthRequired(headers, true);
}
export function createFileOperationHandler(getRoots: () => Promise<Set<string>>) {
  return async (request: Request): Promise<Response> => {
    try {
      const denied = guardFileMutation(request); if (denied) return denied;
      if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405, headers });
      if (!hasJsonContentType(request)) return Response.json({ error: "invalid" }, { status: 415, headers });
      const reader = request.body?.getReader();
      if (!reader) throw new FileOperationError("invalid", 400);
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 16 * 1024) { await reader.cancel(); throw new FileOperationError("too-large", 413); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new FileOperationError("invalid", 400); }
      const command = parseFileOperation(body); // Validate before discovering project roots.
      return Response.json(await performFileOperation(command, await getRoots()), { headers });
    } catch (error) {
      if (error instanceof FileOperationError) return Response.json({ error: error.code, partial: error.partial }, { status: error.status, headers });
      return Response.json({ error: "failed", partial: false }, { status: 503, headers });
    }
  };
}
