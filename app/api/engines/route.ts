import { discoverAgent } from "@/lib/agent-executable";
import { engineLabel, type AgentEngine } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  const engines = (["omp", "pi", "claude", "codex"] as AgentEngine[]).map((engine) => ({ ...discoverAgent(engine), label: engineLabel(engine) }));
  return Response.json({ engines }, { headers: { "Cache-Control": "no-store" } });
}
