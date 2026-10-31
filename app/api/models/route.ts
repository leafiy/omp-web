import { stat } from "fs/promises";
import { resolve, join } from "path";
import { createAgentSessionServices, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { loadModelsWithCache, withModelRuntimeError, type ModelsData } from "../../../lib/models-cache";
import { readOmpModelsFromDb, readOmpConfig, parseOmpDefaultModel, syncOmpRuntimeModelsJson, applyOmpRuntimeCredentials } from "../../../lib/omp-models";
import { buildVisibleRoleModels } from "../../../lib/model-role-filter";
import { readOmpModelsConfig } from "../../../lib/omp-model-config";
import { getOmpAgentDir } from "../../../lib/file-paths";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "../../../lib/file-access";

export const dynamic = "force-dynamic";

const THINKING_SUFFIXES = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function stripThinkingSuffix(modelRef: string): string {
  const trimmed = modelRef.trim();
  const colonIndex = trimmed.lastIndexOf(":");
  if (colonIndex === -1) return trimmed;
  const suffix = trimmed.substring(colonIndex + 1);
  return THINKING_SUFFIXES.has(suffix) ? trimmed.substring(0, colonIndex) : trimmed;
}

function filterByExactEnabledModels<T extends { id: string; provider: string }>(
  available: readonly T[],
  enabledModels: string[] | undefined,
): readonly T[] {
  if (!enabledModels || enabledModels.length === 0) return available;

  const refs = new Set(enabledModels.map(stripThinkingSuffix).filter(Boolean));
  const visible = available.filter((m) => refs.has(`${m.provider}/${m.id}`) || refs.has(m.id));
  return visible.length > 0 ? visible : available;
}

async function loadModels(cwd: string): Promise<ModelsData> {
  const nameMap = new Map<string, string>();
  let modelList: { id: string; name: string; provider: string; contextWindow?: number }[] = [];
  let defaultModel: { provider: string; modelId: string } | null = null;
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};

  const agentDir = getOmpAgentDir();
  const runtimeModelsPath = syncOmpRuntimeModelsJson(agentDir);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: runtimeModelsPath,
  });
  await applyOmpRuntimeCredentials(modelRuntime, agentDir);
  const customProvidersData = (readOmpModelsConfig(agentDir).providers ?? {}) as Record<string, {
    apiKey?: string;
    key?: string;
    models?: Array<{ id: string; name?: string; contextWindow?: number }>;
  }>;

  const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime });
  let available = await services.modelRuntime.getAvailable();
  if (!available || available.length === 0) {
    const dbModels = readOmpModelsFromDb();
    if (dbModels.length > 0) {
      available = dbModels as unknown as typeof available;
    }
  }

  // Merge models defined in models.yml into available if not returned by ModelRuntime.
  const availableArr = [...available];
  for (const [provider, pConfig] of Object.entries(customProvidersData)) {
    if (Array.isArray(pConfig.models)) {
      for (const m of pConfig.models) {
        if (m && m.id && !availableArr.some((x) => x.provider === provider && x.id === m.id)) {
          availableArr.push({
            provider,
            id: m.id,
            name: m.name || m.id,
            contextWindow: m.contextWindow || 128000,
          } as unknown as (typeof available)[number]);
        }
      }
    }
  }
  available = availableArr;

  const modelError = services.modelRuntime.getError();
  const settings = services.settingsManager;
  const enabledModels = settings.getEnabledModels();

  // The runtime knows both web OAuth logins and imported CLI API keys.
  const authedProviderIds = new Set(
    services.modelRuntime.getProviders()
      .filter((provider) => services.modelRuntime.hasConfiguredAuth(provider.id))
      .map((provider) => provider.id),
  );
  for (const p of Object.keys(customProvidersData)) {
    authedProviderIds.add(p);
  }
  const ompConfig = readOmpConfig();
  const roles = ompConfig.modelRoles || {};

  // 1. Filter available models to ONLY authenticated or explicitly configured providers.
  let visible = filterByExactEnabledModels(available, enabledModels);
  if (authedProviderIds.size > 0) {
    visible = visible.filter((m) => authedProviderIds.has(m.provider));
  }

  // Role references can outlive a deleted provider in config.yml. Only retain roles
  // whose provider is configured and whose model still exists in the runtime catalog.
  const roleModelEntries = buildVisibleRoleModels(roles, available, authedProviderIds);

  // 2. Merge role models first, then authenticated models.
  const combinedList: { id: string; name: string; provider: string; contextWindow?: number }[] = [];
  for (const entry of roleModelEntries) {
    const existing = combinedList.find((x) => x.provider === entry.provider && x.id === entry.id);
    if (!existing) {
      combinedList.push({ ...entry });
    }
  }
  for (const m of visible) {
    if (!combinedList.some((x) => x.provider === m.provider && x.id === m.id)) {
      combinedList.push({
        id: m.id,
        name: m.name || m.id,
        provider: m.provider,
        contextWindow: m.contextWindow,
      });
    }
  }

  modelList = combinedList;

  for (const m of modelList) {
    const key = `${m.provider}:${m.id}`;
    nameMap.set(key, m.name);
    thinkingLevels[key] = getSupportedThinkingLevels(m as unknown as Parameters<typeof getSupportedThinkingLevels>[0]);
  }

  const ompDefault = parseOmpDefaultModel(ompConfig);
  if (ompDefault) {
    defaultModel = ompDefault;
  } else if (modelList.length > 0) {
    defaultModel = { provider: modelList[0].provider, modelId: modelList[0].id };
  }

  return withModelRuntimeError(
    {
      models: Object.fromEntries(nameMap),
      modelList,
      defaultModel,
      thinkingLevels,
      thinkingLevelMaps,
      thinkingLevelPins: {},
    },
    modelError,
  );
}

const EMPTY_MODELS: ModelsData = {
  models: {},
  modelList: [],
  defaultModel: null,
  thinkingLevels: {},
  thinkingLevelMaps: {},
  thinkingLevelPins: {},
};

export async function GET(req: Request) {
  const requestedCwd = new URL(req.url).searchParams.get("cwd") || process.cwd();
  const cwd = resolve(requestedCwd);

  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    return Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
  }
  if (!cwdStat.isDirectory()) {
    return Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 });
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  try {
    return Response.json(await loadModelsWithCache(cwd, () => loadModels(cwd)));
  } catch {
    return Response.json(EMPTY_MODELS);
  }
}
