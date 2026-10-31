import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

// omp-models.ts imports sibling modules without extensions, which node's
// native TS support cannot resolve; load it through jiti.
const { syncOmpRuntimeModelsJson, applyOmpRuntimeCredentials } = await createJiti(import.meta.url).import("./omp-models.ts");

test("generated omp-web-models.json validates when cached cost omits cacheWrite", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "omp-models-schema-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const db = new Database(join(agentDir, "models.db"));
  db.exec("CREATE TABLE model_cache (provider_id TEXT PRIMARY KEY, models TEXT)");
  db.prepare("INSERT INTO model_cache VALUES (?, ?)").run(
    "DeepSeek",
    JSON.stringify([
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        api: "openai-completions",
        baseUrl: "https://api.deepseek.com",
        cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: null },
      },
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        api: "openai-completions",
        baseUrl: "https://api.deepseek.com",
        cost: { input: 0.435, output: 0.87, cacheRead: 0.003625 },
      },
    ]),
  );
  db.close();

  const modelsPath = syncOmpRuntimeModelsJson(agentDir);
  const runtime = await ModelRuntime.create({ modelsPath, authPath: join(agentDir, "auth.json"), allowModelNetwork: false });

  // The SDK's ModelCostSchema requires all four rates; a missing/null one
  // previously made the whole models file fail validation.
  assert.equal(runtime.getError(), undefined);

  const content = JSON.parse(await readFile(modelsPath, "utf8"));
  const costs = content.providers.DeepSeek.models.map((m) => m.cost);
  assert.deepEqual(costs, [
    { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
    { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 },
  ]);
});

test("endpoint-less cached catalogs do not break other models and inherit a configured endpoint", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "omp-models-endpoints-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const db = new Database(join(agentDir, "models.db"));
  db.exec("CREATE TABLE model_cache (provider_id TEXT PRIMARY KEY, models TEXT)");
  const insert = db.prepare("INSERT INTO model_cache VALUES (?, ?)");
  insert.run("azure", JSON.stringify([{
    id: "gpt-4.1", provider: "azure", api: "azure-openai-responses", baseUrl: "",
  }]));
  insert.run("deepseek", JSON.stringify([{
    id: "deepseek-v4-flash", provider: "deepseek", api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
  }]));
  db.close();

  const authPath = join(agentDir, "auth.json");
  await writeFile(authPath, JSON.stringify({ deepseek: { type: "api_key", key: "test-key" } }));
  const runtime = await ModelRuntime.create({
    modelsPath: syncOmpRuntimeModelsJson(agentDir), authPath, allowModelNetwork: false,
  });
  assert.equal(runtime.getError(), undefined);
  assert.ok((await runtime.getAvailable("deepseek")).some((model) => model.id === "deepseek-v4-flash"));

  await writeFile(join(agentDir, "models.yml"), JSON.stringify({
    providers: { azure: { baseUrl: "https://deployment.example.openai.azure.com/openai" } },
  }));
  const configured = await ModelRuntime.create({
    modelsPath: syncOmpRuntimeModelsJson(agentDir), authPath, allowModelNetwork: false,
  });
  assert.equal(configured.getError(), undefined);
  assert.equal(configured.getModel("azure", "gpt-4.1")?.baseUrl, "https://deployment.example.openai.azure.com/openai");
});

test("versioned cache keys retain the canonical subscription provider and custom overrides", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "omp-models-provider-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const db = new Database(join(agentDir, "models.db"));
  db.exec("CREATE TABLE model_cache (provider_id TEXT PRIMARY KEY, models TEXT)");
  db.prepare("INSERT INTO model_cache VALUES (?, ?)").run("openai-codex:0.159.0", JSON.stringify([{
    id: "gpt-6-astra", provider: "openai-codex", api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api", contextWindow: 400000,
  }]));
  db.close();
  await writeFile(join(agentDir, "models.yml"), JSON.stringify({
    providers: { "openai-codex": { models: [{ id: "gpt-6-astra", name: "My Codex" }] } },
  }));
  const authPath = join(agentDir, "auth.json");
  await writeFile(authPath, JSON.stringify({
    "openai-codex": { type: "oauth", access: "test-access", refresh: "test-refresh", expires: 4102444800000, accountId: "test-account" },
  }));
  const runtime = await ModelRuntime.create({
    modelsPath: syncOmpRuntimeModelsJson(agentDir), authPath, allowModelNetwork: false,
  });
  assert.equal(runtime.getError(), undefined);
  const model = (await runtime.getAvailable("openai-codex")).find((candidate) => candidate.id === "gpt-6-astra");
  assert.equal(model?.contextWindow, 400000);
  assert.equal(model?.name, "My Codex");
  assert.equal(model?.api, "openai-codex-responses");
  assert.equal(runtime.getProvider("openai-codex:0.159.0"), undefined);
});

test("CLI OAuth tokens do not override web subscription login as API keys", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "omp-models-oauth-"));
  const previousEnv = new Map(["OMP_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"].map((key) => [key, process.env[key]]));
  process.env.OMP_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(agentDir, { recursive: true, force: true });
  });
  const db = new Database(join(agentDir, "agent.db"));
  db.exec("CREATE TABLE auth_credentials (provider TEXT, credential_type TEXT, data TEXT, disabled_cause TEXT, updated_at INTEGER)");
  const insert = db.prepare("INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, ?, ?)");
  insert.run("openai-codex", "oauth", JSON.stringify({
    access: "cli-access", refresh: "cli-refresh", expires: 4102444800000, accountId: "cli-account",
  }));
  insert.run("deepseek", "api_key", JSON.stringify({ key: "deepseek-test-key" }));
  db.close();
  const authPath = join(agentDir, "auth.json");
  const webCredential = {
    type: "oauth", access: "web-access", refresh: "web-refresh", expires: 4102444800000, accountId: "web-account",
  };
  await writeFile(authPath, JSON.stringify({ "openai-codex": webCredential }));
  const runtime = await ModelRuntime.create({ modelsPath: null, authPath, allowModelNetwork: false });
  await applyOmpRuntimeCredentials(runtime, agentDir);
  assert.equal((await runtime.checkAuth("openai-codex"))?.type, "oauth");
  assert.equal((await runtime.checkAuth("deepseek"))?.type, "api_key");
  assert.ok((await runtime.getAvailable("openai-codex")).some((model) => model.id === "gpt-5.4"));
  assert.deepEqual(JSON.parse(await readFile(authPath, "utf8"))["openai-codex"], webCredential);
});
