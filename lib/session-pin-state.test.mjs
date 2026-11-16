import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { SessionPinState } = await jiti.import("./session-pin-state.ts");
const { GET, POST } = await jiti.import("../app/api/sessions/pins/route.ts");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-pin-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state", "pins.json");
  return { dir, path, state: new SessionPinState(path) };
}

for (const id of ["omp-id", "pi:id", "claude:id", "codex:id"]) {
  test(`${id}: pin and unpin are shared snapshots and survive restart`, t => {
    const { path, state } = fixture(t);
    assert.deepEqual(state.snapshot(), { revision: 0, pinnedSessionIds: [] });
    const deviceA = state.setPinned(id, true);
    assert.deepEqual(state.snapshot(), deviceA); // Device B's next poll.
    assert.deepEqual(new SessionPinState(path).snapshot(), deviceA);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const deviceB = state.setPinned(id, false);
    assert.deepEqual(deviceB.pinnedSessionIds, []);
    assert.ok(deviceB.revision > deviceA.revision);
    assert.deepEqual(new SessionPinState(path).snapshot(), deviceB);
  });
}

test("per-session intents preserve other devices' pins and repeated pinning does not toggle or reorder", t => {
  const { state } = fixture(t);
  state.setPinned("same-id", true);
  state.setPinned("pi:same-id", true);
  const both = state.snapshot();
  assert.deepEqual(both.pinnedSessionIds, ["pi:same-id", "same-id"]);
  assert.deepEqual(state.setPinned("same-id", true), both);
  assert.deepEqual(state.setPinned("missing", false), both);
  assert.deepEqual(state.setPinned("same-id", false).pinnedSessionIds, ["pi:same-id"]);
  assert.deepEqual(state.setPinned("same-id", true).pinnedSessionIds, ["same-id", "pi:same-id"]);
});

test("callers cannot mutate the stored list through a snapshot", t => {
  const { state } = fixture(t);
  const copy = state.setPinned("pi:a", true);
  copy.pinnedSessionIds.push("pi:b");
  copy.revision = 999;
  assert.deepEqual(state.snapshot(), { revision: 1, pinnedSessionIds: ["pi:a"] });
});

test("write failure leaves the last confirmed snapshot and persisted data unchanged", t => {
  const { dir, path, state } = fixture(t);
  const before = state.setPinned("a", true);
  const contents = readFileSync(path, "utf8");
  const backup = join(dir, "saved-state");
  renameSync(dirname(path), backup);
  writeFileSync(dirname(path), "not a directory");
  assert.throws(() => state.setPinned("b", true));
  assert.deepEqual(state.snapshot(), before);
  unlinkSync(dirname(path));
  renameSync(backup, dirname(path));
  assert.equal(readFileSync(path, "utf8"), contents);
  assert.deepEqual(new SessionPinState(path).snapshot(), before);
});

test("invalid stored data is reported, not silently replaced with an empty list", t => {
  const { path, state } = fixture(t);
  state.setPinned("a", true);
  for (const value of [null, {}, { revision: -1, pinnedSessionIds: [] }, { revision: 1, pinnedSessionIds: [123] }, { revision: 1, pinnedSessionIds: ["a", "a"] }]) {
    writeFileSync(path, JSON.stringify(value));
    assert.throws(() => new SessionPinState(path), /Invalid session pin state/);
  }
});

function apiFixture(t) {
  const result = fixture(t);
  const previousPath = process.env.OMP_WEB_PIN_STATE_FILE;
  const previousState = globalThis.__ompWebSessionPinState;
  process.env.OMP_WEB_PIN_STATE_FILE = result.path;
  globalThis.__ompWebSessionPinState = undefined;
  t.after(() => {
    if (previousPath === undefined) delete process.env.OMP_WEB_PIN_STATE_FILE;
    else process.env.OMP_WEB_PIN_STATE_FILE = previousPath;
    globalThis.__ompWebSessionPinState = previousState;
  });
  return result;
}

function request(body) {
  return new Request("http://localhost/api/sessions/pins", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

test("pins API shares state across devices without replacing a stale device's entire list", async t => {
  const { path } = apiFixture(t);
  const initial = await GET();
  assert.equal(initial.headers.get("cache-control"), "no-store");
  assert.deepEqual((await initial.json()).pinState.pinnedSessionIds, []);
  assert.equal((await POST(request({ sessionId: "pi:a", pinned: true }))).status, 200);
  const second = await POST(request({ sessionId: "claude:b", pinned: true }));
  assert.equal(second.status, 200);
  assert.deepEqual((await second.json()).pinState.pinnedSessionIds, ["claude:b", "pi:a"]);
  const repeated = await POST(request({ sessionId: "pi:a", pinned: true }));
  assert.equal((await repeated.json()).pinState.revision, 2);
  assert.equal((await POST(request({ sessionId: "pi:a", pinned: false }))).status, 200);
  assert.deepEqual((await (await GET()).json()).pinState.pinnedSessionIds, ["claude:b"]);
  globalThis.__ompWebSessionPinState = undefined; // Simulate service restart.
  assert.deepEqual((await (await GET()).json()).pinState, new SessionPinState(path).snapshot());
});

test("pins API rejects malformed input without modifying state", async t => {
  apiFixture(t);
  for (const body of [null, [], {}, { sessionId: "", pinned: true }, { sessionId: " ", pinned: true }, { sessionId: "x".repeat(513), pinned: true }, { sessionId: "pi:a", pinned: "true" }, { sessionId: 42, pinned: false }]) {
    assert.equal((await POST(request(body))).status, 400);
  }
  assert.equal((await POST(new Request("http://localhost/api/sessions/pins", { method: "POST", body: "{" }))).status, 400);
  assert.deepEqual((await (await GET()).json()).pinState, { revision: 0, pinnedSessionIds: [] });
});

test("pins API reports persistence failure instead of claiming success", async t => {
  const { path } = apiFixture(t);
  await GET();
  writeFileSync(dirname(path), "not a directory");
  const response = await POST(request({ sessionId: "a", pinned: true }));
  assert.equal(response.status, 503);
  assert.deepEqual((await (await GET()).json()).pinState, { revision: 0, pinnedSessionIds: [] });
});
