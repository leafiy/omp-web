import { isAbsolute } from "node:path";
import { parseEngine, type AgentEngine } from "./engine";
import { isApiRequestAllowed } from "./request-security";
import { isRequestAuthenticated, webAuthRequired } from "./web-auth";
import type { NativeSkillsReport } from "./native-skills-types";

const headers = { "Cache-Control": "no-store" };
export function createNativeSkillsHandler(service: {
  resolveCwd(cwd: string): Promise<string | undefined>;
  getSkills(engine: AgentEngine, cwd: string, refresh: boolean): Promise<NativeSkillsReport>;
}) {
  return async function GET(req: Request): Promise<Response> {
    if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted request" }, { status: 403, headers });
    if (!isRequestAuthenticated(req)) return webAuthRequired(headers);
    if (req.method !== "GET") return new Response("Read-only endpoint", { status: 405, headers });
    const params = new URL(req.url).searchParams;
    if ([...params.keys()].some((key) => !["engine", "cwd", "refresh"].includes(key) || params.getAll(key).length !== 1)) return Response.json({ error: "Invalid parameters" }, { status: 400, headers });
    const requestedCwd = params.get("cwd") ?? "";
    if (!isAbsolute(requestedCwd) || requestedCwd.length > 4096 || requestedCwd.includes("\0")) return Response.json({ error: "Select a project directory" }, { status: 400, headers });
    let engine: AgentEngine;
    try { if (!params.has("engine")) throw new Error(); engine = parseEngine(params.get("engine")); }
    catch { return Response.json({ error: "Select a valid agent" }, { status: 400, headers }); }
    let cwd: string | undefined;
    try { cwd = await service.resolveCwd(requestedCwd); } catch { /* Invalid or unreadable path. */ }
    if (!cwd) return Response.json({ error: "Project directory is not accessible" }, { status: 403, headers });
    try { return Response.json(await service.getSkills(engine, cwd, params.get("refresh") === "1"), { headers }); }
    catch { return Response.json({ error: "Unable to read native skills" }, { status: 503, headers }); }
  };
}
