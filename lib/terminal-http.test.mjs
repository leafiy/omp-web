import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { guardTerminalRequest, readTerminalBody } = await jiti.import("./terminal-http.ts");
const { isTerminalId, isTerminalSize } = await jiti.import("./terminal-contract.ts");

function env(t, key, value) {
  const before = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
}
function request(path = "/api/terminal", options = {}) {
  return new Request(`http://localhost${path}`, { ...options, headers: { host: "localhost", ...options.headers } });
}

test("all terminal requests, including events, require configured Basic Auth", (t) => {
  env(t, "PI_WEB_PASSWORD", "test-terminal-password");
  env(t, "OMP_WEB_TERMINAL", undefined);
  const auth = `Basic ${Buffer.from("pi:test-terminal-password").toString("base64")}`;
  for (const path of ["/api/terminal", `/api/terminal/${randomUUID()}/events`]) {
    assert.equal(guardTerminalRequest(request(path)).status, 401);
    assert.equal(guardTerminalRequest(request(path, { headers: { authorization: auth } })), null);
    assert.equal(guardTerminalRequest(request(path, { headers: { authorization: auth, origin: "https://evil.example" } })).status, 403);
    assert.equal(guardTerminalRequest(request(path, { headers: { authorization: auth, "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal(guardTerminalRequest(request(path, { headers: { authorization: auth, host: "evil.example" } })).status, 403);
  }
});

test("operator can disable terminals; POST must be JSON even without a password", (t) => {
  env(t, "PI_WEB_PASSWORD", undefined);
  env(t, "OMP_WEB_TERMINAL", "0");
  assert.equal(guardTerminalRequest(request()).status, 403);
  process.env.OMP_WEB_TERMINAL = "1";
  assert.equal(guardTerminalRequest(request()), null);
  assert.equal(guardTerminalRequest(request(undefined, { method: "POST", body: "x" })).status, 415);
  assert.equal(guardTerminalRequest(request(undefined, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })), null);
});

test("bounded JSON parsing and terminal validation reject malformed payloads", async () => {
  assert.deepEqual(await readTerminalBody(request(undefined, { method: "POST", body: '{"a":1}' })), { a: 1 });
  for (const body of ["[]", "null", "{", JSON.stringify({ data: "x".repeat(128 * 1024) })]) {
    await assert.rejects(readTerminalBody(request(undefined, { method: "POST", body })));
  }
  assert.equal(isTerminalId(randomUUID()), true);
  assert.equal(isTerminalId("../../etc/passwd"), false);
  for (const value of [null, {}, { cols: 80.5, rows: 24 }, { cols: 80, rows: -1 }, { cols: 501, rows: 24 }]) {
    assert.equal(isTerminalSize(value), false);
  }
});

test("actual routes: safe cwd, symlink rejection, auth, input, resize, events and delete", async (t) => {
  env(t, "PI_WEB_PASSWORD", "route-test");
  env(t, "OMP_WEB_TERMINAL", undefined);
  const base = await mkdtemp(join(tmpdir(), "omp-terminal-route-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const allowed = join(base, "allowed");
  const outside = join(base, "outside");
  await mkdir(allowed); await mkdir(outside);
  await symlink(outside, join(allowed, "escape"));
  const previousRoots = globalThis.__ompAllowedRootsCache;
  globalThis.__ompAllowedRootsCache = { roots: new Set([allowed]), expiresAt: Infinity };
  t.after(() => { globalThis.__ompAllowedRootsCache = previousRoots; });
  const writes = [];
  const sizes = [];
  let killed = false;
  const { TerminalRegistry } = await jiti.import("./terminal-manager.ts");
  const registry = new TerminalRegistry(() => ({
    pid: 123, write: (data) => writes.push(data), resize: (...args) => sizes.push(args), kill: () => { killed = true; },
    onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
  }));
  const previousRegistry = globalThis.__ompTerminalRegistry;
  globalThis.__ompTerminalRegistry = registry;
  const id = randomUUID();
  t.after(() => { registry.close(id); globalThis.__ompTerminalRegistry = previousRegistry; });
  const create = await jiti.import("../app/api/terminal/route.ts");
  const control = await jiti.import("../app/api/terminal/[id]/route.ts");
  const events = await jiti.import("../app/api/terminal/[id]/events/route.ts");
  const headers = { authorization: `Basic ${Buffer.from("pi:route-test").toString("base64")}`, "content-type": "application/json" };
  const context = { params: Promise.resolve({ id }) };
  const post = (cwd) => create.POST(request(undefined, { method: "POST", headers, body: JSON.stringify({ id, cwd, cols: 80, rows: 24 }) }));
  assert.equal((await post(outside)).status, 403);
  assert.equal((await post(join(allowed, "escape"))).status, 403);
  assert.equal((await post("relative" )).status, 400);
  assert.equal((await post(allowed)).status, 200);
  assert.equal((await events.GET(request(`/api/terminal/${id}/events`), context)).status, 401);
  assert.equal((await events.GET(request(`/api/terminal/${id}/events`, { headers: { ...headers, "last-event-id": "NaN" } }), context)).status, 400);
  const response = await events.GET(request(`/api/terminal/${id}/events`, { headers }), context);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /"type":"ready"/);
  await reader.cancel();
  for (const body of [{ type: "input", data: "pwd\r" }, { type: "resize", cols: 100, rows: 30 }]) {
    assert.equal((await control.POST(request(`/api/terminal/${id}`, { method: "POST", headers, body: JSON.stringify(body) }), context)).status, 204);
  }
  assert.deepEqual(writes, ["pwd\r"]);
  assert.deepEqual(sizes, [[100, 30]]);
  assert.equal((await control.DELETE(request(`/api/terminal/${id}`, { method: "DELETE", headers }), context)).status, 204);
  assert.equal(killed, true);
  assert.equal((await events.GET(request(`/api/terminal/${id}/events`, { headers }), context)).status, 404);
});
