import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { parseEngine, type AgentEngine } from "@/lib/engine";
import { getPiAgentDir } from "@/lib/engine-paths";
import { getProjectTrustStatus, trustProject } from "@/lib/project-trust";
import { invalidateModelsCache } from "@/lib/models-cache";
import { hasJsonContentType } from "@/lib/request-security";

export const dynamic = "force-dynamic";

async function resolveAllowedCwd(requested: unknown): Promise<string | Response> {
  if (typeof requested !== "string" || !requested) return Response.json({ error: "cwd required" }, { status: 400 });
  const cwd = resolve(requested);
  try {
    if (!(await stat(cwd)).isDirectory()) return Response.json({ error: "cwd must be a directory" }, { status: 400 });
  } catch {
    return Response.json({ error: "Directory does not exist" }, { status: 400 });
  }
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) return Response.json({ error: "Access denied" }, { status: 403 });
  return cwd;
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  let engine: AgentEngine;
  try { engine = parseEngine(params.get("engine")); }
  catch (error) { return Response.json({ error: String(error) }, { status: 400 }); }
  try {
    const cwd = await resolveAllowedCwd(params.get("cwd"));
    if (cwd instanceof Response) return cwd;
    if (engine === "pi") return Response.json({ ...getProjectTrustStatus(cwd, getPiAgentDir()), policy: "pi-native" });
    // Claude MVP does not load project settings, hooks, plugins or MCP servers.
    if (engine === "codex") return Response.json({ requiresTrust: false, trusted: false, policy: "codex-native" });
    if (engine === "claude") return Response.json({ requiresTrust: false, trusted: false, policy: "claude-native" });
    // Pi's trust store is not an OMP sandbox.
    return Response.json({ requiresTrust: false, trusted: false, policy: "omp-native" });
  } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
}

export async function POST(req: Request) {
  if (!hasJsonContentType(req)) return Response.json({ error: "Expected JSON" }, { status: 415 });
  let body: { cwd?: unknown; engine?: unknown };
  let engine: AgentEngine;
  try {
    body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object");
    engine = parseEngine(body.engine);
  } catch (error) { return Response.json({ error: String(error) }, { status: 400 }); }
  if (engine !== "pi") return Response.json({ error: "Pi trust.json does not authorize resources for another engine. Configure trust in that native tool." }, { status: 409 });
  try {
    const cwd = await resolveAllowedCwd(body.cwd);
    if (cwd instanceof Response) return cwd;
    const status = trustProject(cwd, getPiAgentDir());
    invalidateModelsCache();
    return Response.json({ ...status, policy: "pi-native" });
  } catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
}
