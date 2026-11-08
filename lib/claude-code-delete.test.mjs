import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createJiti } from "jiti";

// Set isolated stores before loading the SDK (it caches its config directory).
const root = mkdtempSync(join(tmpdir(), "omp-claude-delete-test-"));
process.env.CLAUDE_CONFIG_DIR = join(root, "native");
process.env.OMP_WEB_CC_STATE_DIR = join(root, "web");
process.env.OMP_CODING_AGENT_DIR = join(root, "omp");
process.env.OMP_WEB_PI_AGENT_DIR = join(root, "pi");
delete process.env.PI_CODING_AGENT_DIR;
after(() => rmSync(root, { recursive: true, force: true }));
const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { deleteClaudeSession } = await jiti.import("./claude-code-delete.ts");
const { withIdleSessionDeletion, startRpcSession } = await jiti.import("./rpc-manager.ts");
const { DELETE } = await jiti.import("../app/api/sessions/[id]/route.ts");
const { resolveSessionPath, cacheSessionPath } = await jiti.import("./session-reader.ts");

function fixture() {
  const id = randomUUID();
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  const nativeDir = join(process.env.CLAUDE_CONFIG_DIR, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  const native = join(nativeDir, `${id}.jsonl`);
  const subagent = join(nativeDir, id, "subagents", "agent-fixture.jsonl");
  const projection = join(process.env.OMP_WEB_CC_STATE_DIR, "sessions", `${id}.jsonl`);
  mkdirSync(join(nativeDir, id, "subagents"), { recursive: true });
  mkdirSync(join(process.env.OMP_WEB_CC_STATE_DIR, "sessions"), { recursive: true });
  writeFileSync(native, JSON.stringify({ type: "user", sessionId: id, cwd, uuid: randomUUID(), message: { role: "user", content: "fixture" } }) + "\n");
  writeFileSync(subagent, "fixture\n");
  writeFileSync(projection, JSON.stringify({ type: "session", version: 3, id, cwd, projection: "claude-code", timestamp: new Date().toISOString() }) + "\n");
  return { id, cwd, native, subagent, projection };
}

test("deletes the exact native transcript, subagents and web projection; preserves siblings", async () => {
  const target = fixture(), sibling = fixture();
  await deleteClaudeSession(`claude:${target.id}`, target.projection);
  for (const path of [target.native, target.subagent, target.projection]) assert.equal(existsSync(path), false);
  for (const path of [sibling.native, sibling.subagent, sibling.projection]) assert.equal(existsSync(path), true);
});

test("empty web drafts with no native transcript can be removed", async () => {
  const target = fixture();
  rmSync(target.native);
  rmSync(join(target.native.replace(/\.jsonl$/, "")), { recursive: true });
  await deleteClaudeSession(`claude:${target.id}`, target.projection);
  assert.equal(existsSync(target.projection), false);
});

test("native deletion errors retain the web record for retry", async () => {
  const target = fixture();
  await assert.rejects(deleteClaudeSession(`claude:${target.id}`, target.projection, async () => { throw new Error("permission denied"); }), /permission denied/);
  assert.equal(existsSync(target.projection), true);
  assert.equal(existsSync(target.native), true);
});

test("rejects wrong engine, path, identity and malformed projection before touching native files", async () => {
  const target = fixture();
  await assert.rejects(deleteClaudeSession(`pi:${target.id}`, target.projection));
  await assert.rejects(deleteClaudeSession(`claude:${randomUUID()}`, target.projection));
  const outside = join(root, "outside.jsonl");
  writeFileSync(outside, "{}\n");
  await assert.rejects(deleteClaudeSession(`claude:${target.id}`, outside));
  writeFileSync(target.projection, JSON.stringify({ type: "session", id: target.id, cwd: target.cwd, projection: "codex-cli", timestamp: new Date().toISOString() }) + "\n");
  await assert.rejects(deleteClaudeSession(`claude:${target.id}`, target.projection));
  assert.equal(existsSync(target.native), true);
});

test("busy or starting sessions cannot be deleted", async () => {
  const id = `claude:${randomUUID()}`;
  globalThis.__ompWebSessions = new Map([[id, { isRunning: () => true }]]);
  await assert.rejects(withIdleSessionDeletion(id, async () => assert.fail("must not delete")), /running/i);
  globalThis.__ompWebSessions.clear();
  globalThis.__ompWebStartLocks = new Map([[`claude:${id}`, Promise.resolve()]]);
  await assert.rejects(withIdleSessionDeletion(id, async () => assert.fail("must not delete")), /starting/i);
  globalThis.__ompWebStartLocks.clear();
});

test("DELETE route authenticates, refuses busy sessions, deletes both stores and invalidates identity cache", async () => {
  const target = fixture();
  const id = `claude:${target.id}`;
  const previous = { PI_WEB_PASSWORD: process.env.PI_WEB_PASSWORD, PI_WEB_PASSWORD_FILE: process.env.PI_WEB_PASSWORD_FILE };
  process.env.PI_WEB_PASSWORD = "fixture-only-password";
  delete process.env.PI_WEB_PASSWORD_FILE;
  const request = (authorized = true, origin = "http://localhost") => new Request(`http://localhost/api/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE", headers: { host: "localhost", origin, ...(authorized ? { authorization: `Basic ${Buffer.from("pi:fixture-only-password").toString("base64")}` } : {}) },
  });
  const params = { params: Promise.resolve({ id }) };
  try {
    cacheSessionPath(id, target.projection);
    assert.equal((await DELETE(request(false), params)).status, 401);
    assert.equal((await DELETE(request(true, "https://evil.example"), params)).status, 403);
    globalThis.__ompWebSessions = new Map([[id, { isRunning: () => true }]]);
    assert.equal((await DELETE(request(), params)).status, 409);
    assert.equal(existsSync(target.native), true);
    globalThis.__ompWebSessions.clear();
    const response = await DELETE(request(), params);
    assert.equal(response.status, 200, await response.text());
    assert.equal(existsSync(target.native), false);
    assert.equal(existsSync(target.subagent), false);
    assert.equal(existsSync(target.projection), false);
    assert.equal(await resolveSessionPath(id), null);
    assert.equal((await DELETE(request(), params)).status, 404);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    globalThis.__ompWebSessions.clear();
  }
});

test("idle session closes before deletion; concurrent resume/deletion is blocked; lock releases on failure", async () => {
  const id = `claude:${randomUUID()}`;
  const order = [];
  globalThis.__ompWebSessions = new Map([[id, { isRunning: () => false, shutdown: async () => { order.push("shutdown"); globalThis.__ompWebSessions.delete(id); } }]]);
  await assert.rejects(withIdleSessionDeletion(id, async () => {
    order.push("delete");
    await assert.rejects(startRpcSession(id, "/unused", undefined), /delet/i);
    await assert.rejects(withIdleSessionDeletion(id, async () => {}), /delet/i);
    throw new Error("retryable failure");
  }), /retryable failure/);
  assert.deepEqual(order, ["shutdown", "delete"]);
  await withIdleSessionDeletion(id, async () => order.push("retry"));
  assert.equal(order.at(-1), "retry");
});
