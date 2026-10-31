import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createJiti } from "jiti";
import { spawn } from "@lydell/node-pty";

const jiti = createJiti(import.meta.url);
const { TerminalRegistry } = await jiti.import("./terminal-manager.ts");
const { terminalEventResponse } = await jiti.import("./terminal-stream.ts");
const size = { cols: 80, rows: 24 };

function fakePty() {
  let dataHandler;
  let exitHandler;
  return {
    pid: 42, writes: [], sizes: [], killed: false,
    onData(fn) { dataHandler = fn; return { dispose() { dataHandler = undefined; } }; },
    onExit(fn) { exitHandler = fn; return { dispose() { exitHandler = undefined; } }; },
    write(data) { this.writes.push(data); },
    resize(cols, rows) { this.sizes.push({ cols, rows }); },
    kill() { this.killed = true; },
    output(data) { dataHandler?.(data); },
    exit(exitCode = 0) { exitHandler?.({ exitCode }); },
  };
}

function fixture(t, timeout = 60_000) {
  const pty = fakePty();
  let spawns = 0;
  const registry = new TerminalRegistry(() => { spawns++; return pty; }, timeout);
  const id = randomUUID();
  t.after(() => registry.close(id));
  registry.open(id, "/tmp", size);
  return { registry, id, pty, get spawns() { return spawns; } };
}

test("opening is idempotent and refuses to move an existing shell to another cwd", (t) => {
  const f = fixture(t);
  assert.equal(f.registry.open(f.id, "/tmp", size).pid, 42);
  assert.equal(f.spawns, 1);
  assert.throws(() => f.registry.open(f.id, "/elsewhere", size), { status: 409 });
  const terminal = f.registry.get(f.id);
  terminal.write("echo hello\r");
  terminal.resize({ cols: 120, rows: 40 });
  assert.deepEqual(f.pty.writes, ["echo hello\r"]);
  assert.deepEqual(f.pty.sizes.at(-1), { cols: 120, rows: 40 });
  assert.throws(() => terminal.write("a".repeat(16_385)), { status: 400 });
  assert.throws(() => terminal.resize({ cols: 0, rows: 900 }), { status: 400 });
});

test("reconnect replays only missing frames; bounded history reports a gap", (t) => {
  const { registry, id, pty } = fixture(t);
  pty.output("one"); pty.output("two");
  const replay = [];
  const detach = registry.get(id).subscribe(1, (event) => replay.push(event));
  assert.deepEqual(replay.map((event) => event.type), ["output", "ready"]);
  assert.equal(replay[0].data, "two");
  pty.output("three");
  assert.equal(replay.at(-1).data, "three");
  detach();
  pty.output("z".repeat(600_000));
  const bounded = [];
  registry.get(id).subscribe(0, (event) => bounded.push(event))();
  assert.equal(bounded[0].type, "reset");
  assert.ok(bounded.filter((event) => event.type === "output").reduce((n, event) => n + event.data.length, 0) <= 256 * 1024);
});

test("detaching does not kill immediately, attaching cancels idle expiry", async (t) => {
  const { registry, id, pty } = fixture(t, 40);
  const detach = registry.get(id).subscribe(0, () => {});
  await delay(70);
  assert.equal(pty.killed, false);
  detach();
  assert.equal(pty.killed, false);
  await delay(70);
  assert.equal(pty.killed, true);
  assert.throws(() => registry.get(id), { status: 404 });
});

test("exited shells retain exit status and require explicit termination before a new shell", (t) => {
  const f = fixture(t);
  f.pty.exit(7);
  assert.equal(f.registry.open(f.id, "/tmp", size).alive, false);
  assert.equal(f.spawns, 1);
  assert.throws(() => f.registry.get(f.id).write("ignored"), { status: 409 });
  const replay = [];
  f.registry.get(f.id).subscribe(0, (event) => replay.push(event))();
  assert.equal(replay[0].exitCode, 7);
  f.registry.close(f.id);
  assert.throws(() => f.registry.get(f.id), { status: 404 });
});

test("terminal count is bounded and closing releases a slot", () => {
  const registry = new TerminalRegistry(fakePty);
  const ids = Array.from({ length: 9 }, () => randomUUID());
  try {
    for (const id of ids.slice(0, 8)) registry.open(id, "/tmp", size);
    assert.throws(() => registry.open(ids[8], "/tmp", size), { status: 429 });
    registry.close(ids[0]);
    registry.open(ids[8], "/tmp", size);
  } finally { for (const id of ids) registry.close(id); }
});

test("SSE streams are cancellable, replay event IDs and detach without killing", async (t) => {
  const { registry, id, pty } = fixture(t);
  pty.output("hello");
  const response = terminalEventResponse(new Request("http://localhost/events"), registry.get(id), 0);
  assert.equal(response.headers.get("X-Accel-Buffering"), "no");
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /id: 1\ndata: .*hello/);
  await reader.cancel();
  assert.equal(pty.killed, false);
  registry.get(id).write("still here");
});

test("slow SSE consumers are disconnected rather than retaining unbounded output", async (t) => {
  const { registry, id, pty } = fixture(t);
  const response = terminalEventResponse(new Request("http://localhost/events"), registry.get(id), 0);
  pty.output("x".repeat(2_000_000));
  const reader = response.body.getReader();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
  }
  assert.ok(bytes < 700_000);
  assert.equal(pty.killed, false);
});

test("real PTY: interactive shell, cwd, ANSI output, resize, Ctrl+C and exit", { skip: process.platform === "win32", timeout: 15_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "omp-terminal-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const registry = new TerminalRegistry((directory, dimensions) => spawn("/bin/bash", ["--noprofile", "--norc"], {
    cwd: directory, cols: dimensions.cols, rows: dimensions.rows, name: "xterm-256color",
    env: { PATH: process.env.PATH, HOME: cwd, TERM: "xterm-256color", PS1: "TEST> " },
  }));
  const id = randomUUID();
  t.after(() => registry.close(id));
  registry.open(id, cwd, size);
  const terminal = registry.get(id);
  let output = "";
  let exit;
  const detach = terminal.subscribe(0, (event) => {
    if (event.type === "output") output += event.data;
    if (event.type === "exit") exit = event.exitCode;
  });
  t.after(detach);
  async function until(predicate) {
    for (let i = 0; i < 150; i++) { if (predicate()) return; await delay(30); }
    assert.fail(`PTY timed out: ${JSON.stringify(output)}`);
  }
  await until(() => output.includes("TEST> "));
  terminal.write("printf '\\033[31mCOLOR\\033[0m\\n'; pwd\r");
  await until(() => output.includes("\x1b[31mCOLOR\x1b[0m") && output.includes(cwd));
  terminal.resize({ cols: 101, rows: 37 });
  terminal.write("stty size\r");
  await until(() => output.includes("37 101"));
  terminal.write("sleep 20\r");
  await delay(150);
  terminal.write("\x03");
  terminal.write("printf 'INTERRUPT_%s\\n' OK\r");
  await until(() => output.includes("INTERRUPT_OK"));
  terminal.write("exit 7\r");
  await until(() => exit === 7);
  assert.equal(terminal.info.alive, false);
});
