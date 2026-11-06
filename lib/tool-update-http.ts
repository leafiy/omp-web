import { parseToolUpdateRequest, type ToolUpdatesSnapshot, type UpdatableTool } from "./tool-update-types";
import { ToolUpdateError } from "./tool-update";
import { hasJsonContentType, isApiRequestAllowed } from "./request-security";
import { isValidBasicAuthorization, isWebPasswordEnabled } from "./web-auth";

const headers = { "Cache-Control": "no-store" };
type UpdateService = {
  getStatus: () => ToolUpdatesSnapshot | Promise<ToolUpdatesSnapshot>;
  start: (tool: UpdatableTool) => Promise<ToolUpdatesSnapshot>;
};

/** HTTP policy is testable without ever invoking a real software updater. */
export function createToolUpdateHandlers(service: UpdateService) {
  function guard(req: Request): Response | undefined {
    if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted update request" }, { status: 403, headers });
    if (isWebPasswordEnabled() && !isValidBasicAuthorization(req.headers.get("authorization"))) {
      return new Response("Authentication required", { status: 401, headers: { ...headers, "WWW-Authenticate": 'Basic realm="Pi Web", charset="UTF-8"' } });
    }
  }
  function failure(error: unknown): Response {
    if (error instanceof ToolUpdateError) return Response.json({ error: error.message }, { status: error.status, headers });
    console.error("Software update request failed", error);
    return Response.json({ error: "Unable to manage software updates. Check the web service logs." }, { status: 500, headers });
  }
  return {
    async GET(req: Request): Promise<Response> {
      const denied = guard(req);
      if (denied) return denied;
      try { return Response.json(await service.getStatus(), { headers }); }
      catch (error) { return failure(error); }
    },
    async POST(req: Request): Promise<Response> {
      const denied = guard(req);
      if (denied) return denied;
      if (!hasJsonContentType(req)) return Response.json({ error: "Expected JSON" }, { status: 415, headers });
      let tool: UpdatableTool;
      try { tool = parseToolUpdateRequest(await req.json()); }
      catch { return Response.json({ error: "Confirm one of pi, omp, claude or codex with {tool, confirm:true}." }, { status: 400, headers }); }
      try { return Response.json(await service.start(tool), { status: 202, headers }); }
      catch (error) { return failure(error); }
    },
  };
}
