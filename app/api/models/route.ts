import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { AgentRpcClient } from "@/lib/agent-rpc-client";
import { loadModelsWithCache, type ModelsData } from "@/lib/models-cache";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { parseEngine, type AgentEngine } from "@/lib/engine";
import { ClaudeCodeSession } from "@/lib/claude-code-session";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { claudeModelsData, type ClaudeModelSettings } from "@/lib/claude-models";
import { CodexRpcClient, denyCodexRequest, listCodexModels } from "@/lib/codex-rpc-client";

export const dynamic = "force-dynamic";

const EMPTY_MODELS: ModelsData = {
  models: {}, modelList: [], defaultModel: null,
  thinkingLevels: {}, thinkingLevelMaps: {}, thinkingLevelPins: {},
};

async function loadModels(cwd: string, engine: AgentEngine): Promise<ModelsData> {
  if (engine === "codex") {
    const client = new CodexRpcClient(cwd);
    client.onFrame((frame) => { if (frame.id !== undefined) denyCodexRequest(client, frame); });
    try {
      await client.start();
      const models = await listCodexModels(client);
      const modelList = models.map((m) => ({ id: m.model as string, provider: "codex-cli", name: String(m.displayName || m.model) }));
      // Catalog isDefault can differ from this project's configured model.
      // Let thread/start report the actual native selection; never guess it.
      return { ...EMPTY_MODELS, modelList, models: Object.fromEntries(modelList.map((m) => [`codex-cli:${m.id}`, m.name])), defaultModel: null };
    } finally { client.destroy(); }
  }
  if (engine === "claude") {
    const session = new ClaudeCodeSession({ cwd, catalogOnly: true }, () => {});
    try {
      await session.start();
      const catalog = await session.send({ type: "get_available_models" }) as { models: ModelInfo[]; settings?: ClaudeModelSettings; effortControlAvailable: boolean };
      return claudeModelsData(catalog.models, catalog.settings, catalog.effortControlAvailable);
    } finally { await session.shutdown(); }
  }
  // Each engine discovers its own credentials, project config and models.
  // Never translate one engine's credentials into the other runtime.
  const client = new AgentRpcClient({ cwd, engine, catalogOnly: true });
  try {
    await client.start();
    const { models } = await client.request<{ models: Array<{ id: string; provider: string; name?: string; contextWindow?: number }> }>({ type: "get_available_models" });
    const state = await client.request<{ model?: { id: string; provider: string } }>({ type: "get_state" });
    const thinkingLevels: Record<string, string[]> = {};
    if (state.model) {
      // Older engine releases may not implement this discovery command.
      try {
        const { levels } = await client.request<{ levels: string[] }>({ type: "get_available_thinking_levels" });
        thinkingLevels[`${state.model.provider}:${state.model.id}`] = levels;
      } catch { /* The selected engine validates set_thinking_level. */ }
    }
    const modelList = models.map((model) => ({ id: model.id, provider: model.provider, name: model.name || model.id, contextWindow: model.contextWindow }));
    return {
      ...EMPTY_MODELS,
      modelList,
      models: Object.fromEntries(modelList.map((model) => [`${model.provider}:${model.id}`, model.name])),
      defaultModel: state.model ? { provider: state.model.provider, modelId: state.model.id } : null,
      thinkingLevels,
    };
  } finally {
    await client.shutdown();
  }
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  let engine: AgentEngine;
  try { engine = parseEngine(params.get("engine")); }
  catch (error) { return Response.json({ error: String(error) }, { status: 400 }); }
  const cwd = resolve(params.get("cwd") || process.cwd());
  let cwdStat;
  try { cwdStat = await stat(cwd); }
  catch { return Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 }); }
  if (!cwdStat.isDirectory()) return Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 });
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }
  try {
    return Response.json(await loadModelsWithCache(`${engine}\0${cwd}`, () => loadModels(cwd, engine)));
  } catch (error) {
    return Response.json({ ...EMPTY_MODELS, modelError: `Local ${engine.toUpperCase()}: ${error instanceof Error ? error.message : String(error)}` });
  }
}
