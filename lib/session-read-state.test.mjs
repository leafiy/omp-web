import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SessionReadState } = await jiti.import("./session-read-state.ts");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-read-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "reads.json");
  return { path, state: new SessionReadState(path) };
}

for (const id of ["omp-id", "pi:id", "claude:id", "codex:id"]) {
  test(`${id}: reading on device A clears device B and survives restart`, t => {
    const { state, path } = fixture(t);
    state.observeRunning([id]);
    state.observeRunning([]);
    const deviceB = state.snapshot();
    assert.ok(deviceB.unread[id]);
    state.acknowledge(state.snapshot().unread); // Device A opens the conversation.
    assert.deepEqual(state.snapshot().unread, {}); // Device B's next poll.
    state.observeRunning([]); // B reconnecting cannot recreate a completion.
    assert.deepEqual(state.snapshot().unread, {});
    assert.deepEqual(new SessionReadState(path).snapshot().unread, {});
    assert.ok(state.snapshot().revision > deviceB.revision);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
}

test("late read receipts cannot clear a newer completion", t => {
  const { state } = fixture(t);
  state.observeRunning(["claude:a"]);
  state.observeRunning([]);
  const old = state.snapshot();
  state.observeRunning(["claude:a"]);
  state.observeRunning([]);
  const current = state.snapshot();
  assert.ok(current.unread["claude:a"] > old.unread["claude:a"]);
  assert.deepEqual(state.acknowledge(old.unread), current);
  assert.deepEqual(state.acknowledge(current.unread).unread, {});
});

test("project batch read leaves other projects and subsequent work unread", t => {
  const { state } = fixture(t);
  state.observeRunning(["claude:a", "pi:b", "codex:other"]);
  state.observeRunning([]);
  const before = state.snapshot();
  state.observeRunning(["pi:b"]);
  state.observeRunning([]);
  const after = state.acknowledge({ "claude:a": before.unread["claude:a"], "pi:b": before.unread["pi:b"] });
  assert.equal(after.unread["claude:a"], undefined);
  assert.ok(after.unread["pi:b"]);
  assert.equal(after.unread["codex:other"], before.unread["codex:other"]);
});

test("restart preserves unread completions but does not invent a completion for interrupted work", t => {
  const { state, path } = fixture(t);
  state.observeRunning(["done", "interrupted"]);
  state.observeRunning(["interrupted"]);
  const restarted = new SessionReadState(path);
  restarted.observeRunning([]);
  assert.deepEqual(restarted.snapshot(), state.snapshot());
  assert.deepEqual(Object.keys(restarted.snapshot().unread), ["done"]);
});

test("unchanged polling and duplicate receipts do not rewrite state", t => {
  const { state } = fixture(t);
  state.observeRunning(["a"]);
  state.observeRunning([]);
  const receipt = state.snapshot();
  state.observeRunning([]);
  assert.deepEqual(state.snapshot(), receipt);
  const read = state.acknowledge(receipt.unread);
  assert.deepEqual(state.acknowledge(receipt.unread), read);
  const copy = state.snapshot();
  copy.unread.a = 999;
  assert.deepEqual(state.snapshot(), read);
});
