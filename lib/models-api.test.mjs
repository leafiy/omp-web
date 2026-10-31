import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

test("model selector includes web OAuth subscriptions alongside CLI API-key providers", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "omp-model-selector-"));
  const previousEnv = new Map(["HOME", "OMP_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR", "PI_OFFLINE"].map((key) => [key, process.env[key]]));
  process.env.HOME = agentDir;
  process.env.OMP_CODING_AGENT_DIR = agentDir;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  t.after(async () => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(agentDir, { recursive: true, force: true });
  });
  const db = new Database(join(agentDir, "agent.db"));
  db.exec("CREATE TABLE auth_credentials (provider TEXT, credential_type TEXT, data TEXT, disabled_cause TEXT, updated_at INTEGER)");
  db.prepare("INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, ?, ?)").run(
    "deepseek", "api_key", JSON.stringify({ key: "test-key" }),
  );
  db.close();
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({
    "openai-codex": { type: "oauth", access: "web-access", refresh: "web-refresh", expires: 4102444800000, accountId: "test-account" },
  }));
  await writeFile(join(agentDir, "config.yml"), JSON.stringify({ modelRoles: { default: "openai-codex/gpt-5.4" } }));

  const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
  const { allowFileRoot } = await jiti.import("./file-access.ts");
  const { GET } = await jiti.import("../app/api/models/route.ts");
  allowFileRoot(agentDir);
  const response = await GET(new Request(`http://localhost/api/models?cwd=${encodeURIComponent(agentDir)}`));
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.modelError, undefined);
  assert.ok(data.modelList.some((model) => model.provider === "openai-codex" && model.id === "gpt-5.4"));
  assert.ok(data.modelList.some((model) => model.provider === "deepseek"));
  assert.deepEqual(data.defaultModel, { provider: "openai-codex", modelId: "gpt-5.4" });
});
