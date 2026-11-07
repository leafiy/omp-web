import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getClaudeConfig, claudeChildEnvironment } = await jiti.import("./claude-code-config.ts");
const { ClaudeEventProjector } = await jiti.import("./claude-code-events.ts");
const { claudeSlashCommands } = await jiti.import("./claude-code-commands.ts");
const { ClaudeCodeSession } = await jiti.import("./claude-code-session.ts");
const { engineForSession, nativeSessionId, parseEngine, sessionKey } = await jiti.import("./engine.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), "omp-web-cc-test-"));
  const keyFile = join(dir, "proxy.key");
  await writeFile(keyFile, "fake-local-proxy-key\n", { mode: 0o600 });
  const env = {
    OMP_WEB_CC_EXECUTABLE: "/fake/claude",
    OMP_WEB_CC_BASE_URL: "http://127.0.0.1:8317",
    OMP_WEB_CC_MODEL: "test-codex-model",
    OMP_WEB_CC_API_KEY_FILE: keyFile,
    OMP_WEB_CC_STATE_DIR: dir,
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try { await run({ dir, keyFile, env }); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeFactory(commands = [], readContext = async () => ({}), interruptReply = async () => undefined, recallReply = async () => ({ response: { cancelled: false } })) {
  let captured;
  const contextRequests = [], interruptOptions = [], controlRequests = [];
  let resolveNext;
  const pending = [];
  const prompts = [];
  let ended = false;
  let interrupts = 0;
  const q = {
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (pending.length) return Promise.resolve({ value: pending.shift(), done: false });
      if (ended) return Promise.resolve({ done: true });
      return new Promise((resolve) => { resolveNext = resolve; });
    },
    initializationResult: async () => ({}),
    supportedModels: async () => [{ value: "test-native-model", displayName: "Native model" }],
    supportedCommands: async () => commands,
    request: async (request) => { controlRequests.push(request); return recallReply(request); },
    getContextUsage: async (options) => { contextRequests.push(options); return readContext(); },
    setModel: async () => {},
    interrupt: async (options) => { interrupts++; interruptOptions.push(options); return interruptReply(options); },
    close() { ended = true; resolveNext?.({ done: true }); resolveNext = undefined; },
  };
  return {
    factory(params) {
      captured = params;
      void (async () => { for await (const value of params.prompt) prompts.push(value); })();
      return q;
    },
    frame(value) {
      if (resolveNext) { const resolve = resolveNext; resolveNext = undefined; resolve({ value, done: false }); }
      else pending.push(value);
    },
    get options() { return captured.options; },
    get prompts() { return prompts; },
    get interrupts() { return interrupts; },
    get contextRequests() { return contextRequests; },
    get interruptOptions() { return interruptOptions; },
    get controlRequests() { return controlRequests; },
  };
}

const assistant = (session_id, text, uuid = "assistant-1") => ({
  type: "assistant", session_id, parent_tool_use_id: null, uuid,
  message: { model: "test-codex-model", content: [{ type: "text", text }] },
});

test("background tasks outlive the Claude prompt and replay independently of private transcripts", async () => fixture(async ({ dir }) => {
  const fake = fakeFactory();
  const session = new ClaudeCodeSession({ cwd: dir }, () => {}, fake.factory);
  try {
    await session.start();
    const nativeId = nativeSessionId(session.sessionId);
    await session.send({ type: "prompt", message: "delegate" });
    await tick();
    fake.frame({ type: "system", subtype: "background_tasks_changed", session_id: nativeId, tasks: [{ task_id: "child", description: "Review" }] });
    const permission = fake.options.canUseTool("Bash", { command: "printf child" }, { signal: new AbortController().signal, agentID: "child", toolUseID: "child-tool", requestId: "child-approval" });
    fake.frame({ ...assistant(nativeId, "PRIVATE CHILD"), parent_tool_use_id: "spawn" });
    fake.frame({ type: "result", session_id: nativeId, uuid: "done", subtype: "success", is_error: false, user_message_uuid: fake.prompts[0].uuid });
    await tick();
    const state = await session.send({ type: "get_state" });
    assert.equal(state.isPromptRunning, false);
    assert.equal(state.isSettled, false);
    assert.equal(session.isRunning(), true);
    assert.equal(state.tasks.tasks[0].active, true);
    assert.equal(JSON.stringify(await session.send({ type: "get_messages" })).includes("PRIVATE CHILD"), false);
    const replay = [];
    session.onEvent(event => replay.push(event))();
    assert.equal(replay.find(e => e.type === "task_snapshot").snapshot.tasks[0].id, "child");
    const childDialog = replay.find(e => e.type === "extension_ui_request");
    assert.ok(childDialog, "parent settlement must not cancel the child approval");
    await session.send({ type: "extension_ui_response", id: childDialog.id, value: "Deny" });
    assert.equal((await permission).behavior, "deny");
    fake.frame({ type: "system", subtype: "task_notification", session_id: nativeId, task_id: "child", status: "completed" });
    fake.frame({ type: "system", subtype: "background_tasks_changed", session_id: nativeId, tasks: [] });
    await tick();
    assert.equal(session.isRunning(), false);
    assert.equal((await session.send({ type: "get_state" })).tasks.tasks[0].status, "completed");
    const continuation = []; session.onEvent(e => continuation.push(e));
    fake.frame(assistant(nativeId, "AUTONOMOUS SUMMARY", "continuation-message"));
    await tick();
    assert.equal((await session.send({ type: "get_state" })).isPromptRunning, true);
    fake.frame({ type: "result", session_id: nativeId, uuid: "continuation-result", subtype: "success", is_error: false });
    await tick();
    assert.equal(session.isRunning(), false);
    assert.ok(continuation.some(e => e.type === "agent_start"));
    assert.ok(continuation.some(e => e.type === "agent_settled"));
  } finally { session.destroy(); }
}));

test("Claude task detail reads only an owned child, never the main conversation", async () => fixture(async ({ dir }) => {
  const fake = fakeFactory(), reads = [];
  const session = new ClaudeCodeSession({ cwd: dir }, () => {}, fake.factory, async (...args) => {
    reads.push(args);
    return [{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "CHILD DETAIL" }] } }];
  });
  try {
    await session.start();
    await assert.rejects(session.send({ type: "get_task_detail", taskId: "foreign" }), /Unknown task/);
    assert.equal(reads.length, 0);
    fake.frame({ type: "system", subtype: "task_started", session_id: nativeSessionId(session.sessionId), task_id: "child", task_type: "local_agent" });
    await tick();
    const detail = await session.send({ type: "get_task_detail", taskId: "child" });
    assert.equal(detail.messages[0].text, "CHILD DETAIL");
    assert.deepEqual(reads, [[nativeSessionId(session.sessionId), "child", dir]]);
    assert.equal(JSON.stringify(await session.send({ type: "get_messages" })).includes("CHILD DETAIL"), false);
  } finally { session.destroy(); }
}));

// All tests use fake SDK queries and temporary state. No CLI, OAuth, proxy or model.
test("four engines keep opaque identities separate; unknown engines fail", () => {
  for (const engine of ["omp", "pi", "claude", "codex"]) {
    assert.equal(engineForSession(sessionKey(engine, "same-id")), engine);
    assert.equal(nativeSessionId(sessionKey(engine, "same-id")), "same-id");
  }
  assert.equal(parseEngine("claude"), "claude");
  assert.equal(parseEngine("codex"), "codex");
  assert.throws(() => parseEngine("unknown"));
});

test("Claude uses native settings and never reads a web-managed proxy credential", async () => fixture(async ({ env, keyFile }) => {
  assert.equal(getClaudeConfig(env).executable, "/fake/claude");
  const original = { ...env, ANTHROPIC_API_KEY: "native-test-key", CLAUDE_CONFIG_DIR: "/native/claude", PI_WEB_PASSWORD: "web-secret", PI_WEB_PASSWORD_FILE: "/web/password", PI_CODING_AGENT_DIR: "/omp" };
  const child = claudeChildEnvironment(original);
  assert.equal(child.ANTHROPIC_API_KEY, "native-test-key");
  assert.equal(child.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(child.CLAUDE_CONFIG_DIR, "/native/claude");
  assert.equal(child.PI_CODING_AGENT_DIR, undefined);
  assert.equal(child.PI_WEB_PASSWORD, undefined);
  assert.equal(child.PI_WEB_PASSWORD_FILE, undefined);
  assert.equal(child.OMP_WEB_CC_API_KEY_FILE, undefined);
  await rm(keyFile);
  assert.equal(claudeChildEnvironment(env).ANTHROPIC_AUTH_TOKEN, undefined);
}));

test("streaming snapshots stay immutable and only complete messages are committed", () => {
  const p = new ClaudeEventProjector("test-codex-model");
  const stream = (event) => p.consume({ type: "stream_event", event, parent_tool_use_id: null });
  stream({ type: "message_start" });
  stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  const first = stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你" } });
  stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } });
  assert.equal(first[0].message.content[0].text, "你");
  assert.equal(first[0].type, "message_update");
  assert.equal(p.consume(assistant("s", "你好"))[0].type, "message_end");
  assert.deepEqual(p.consume(assistant("s", "你好")), []);
  assert.deepEqual(p.consume({ ...assistant("s", "private", "sub"), parent_tool_use_id: "task" }), []);
});

test("Claude state exposes the native context summary instead of losing a configured 1M window", async () => fixture(async ({ dir }) => {
  const fake = fakeFactory([], async () => ({ model: "test-native-model", maxTokens: 1000000, rawMaxTokens: 1000000, totalTokens: 12000, percentage: 1.2, memoryFiles: [{ path: "private-path-must-not-leak" }] }));
  const s = new ClaudeCodeSession({ cwd: dir }, () => {}, fake.factory);
  try {
    await s.start();
    const state = await s.send({ type: "get_state" });
    assert.deepEqual(state.contextUsage, { contextWindow: 1000000, tokens: 12000, percent: 1.2 });
    assert.ok(!JSON.stringify(state).includes("private-path-must-not-leak"));
    assert.deepEqual(fake.contextRequests, [{ detail: "summary" }]);
    assert.equal(fake.prompts.length, 0);
    assert.equal(s.isRunning(), false);
  } finally { await s.shutdown(); }
}));

test("Claude summaries refresh after model changes and turns; busy chats are not probed", async () => fixture(async ({ dir }) => {
  let window = 1000000;
  const fake = fakeFactory([], async () => ({ maxTokens: window, totalTokens: 0, percentage: 0 }));
  const s = new ClaudeCodeSession({ cwd: dir }, () => {}, fake.factory);
  try {
    await s.start();
    await Promise.all([s.send({ type: "get_state" }), s.send({ type: "get_session_stats" })]);
    assert.equal(fake.contextRequests.length, 1);
    window = 200000;
    await s.send({ type: "set_model", provider: "claude-code", modelId: "test-native-model" });
    assert.equal((await s.send({ type: "get_state" })).contextUsage.contextWindow, 200000);
    await s.send({ type: "prompt", message: "synthetic test" });
    assert.equal((await s.send({ type: "get_state" })).contextUsage, null);
    assert.equal(fake.contextRequests.length, 2);
    fake.frame({ type: "result", session_id: nativeSessionId(s.sessionId), is_error: false });
    await tick();
    assert.equal((await s.send({ type: "get_state" })).contextUsage.contextWindow, 200000);
    assert.equal(fake.contextRequests.length, 3);
    assert.ok(fake.contextRequests.every((request) => request.detail === "summary"));
  } finally { await s.shutdown(); }
}));

test("Claude missing summary support returns unknown without fabricating context or failing the session", async () => fixture(async ({ dir }) => {
  const fake = fakeFactory([], async () => { throw new Error("private-native-error"); });
  const s = new ClaudeCodeSession({ cwd: dir }, () => {}, fake.factory);
  try {
    await s.start();
    const state = await s.send({ type: "get_state" });
    assert.equal(state.contextUsage, null);
    assert.ok(!JSON.stringify(state).includes("private-native-error"));
    assert.equal(s.isAlive(), true);
    assert.equal(fake.prompts.length, 0);
  } finally { await s.shutdown(); }
}));

test("Claude command discovery exposes the native catalog without submitting a prompt", async () => fixture(async ({ dir }) => {
  const fake = fakeFactory([
    { name: "review", description: "Review project changes", argumentHint: "<path>" },
  ]);
  const s = new ClaudeCodeSession({ cwd: dir }, () => {}, fake.factory);
  try {
    await s.start();
    const { commands } = await s.send({ type: "get_commands" });
    assert.equal(commands.length, 1);
    assert.equal(commands[0].name, "review");
    assert.equal(commands[0].description, "Review project changes");
    assert.equal(commands[0].source, "claude");
    assert.equal(commands[0].argumentHint, "<path>");
    assert.equal(fake.prompts.length, 0);
    assert.equal(s.isRunning(), false);
  } finally { await s.shutdown(); }
}));

test("Claude skill metadata uses a non-persistent catalog and never sends a prompt", async () => fixture(async ({ dir }) => {
  const commands = [{ name: "effort", description: "Builtin", argumentHint: "", builtin: true }, { name: "review", description: "Project skill", argumentHint: "" }];
  const fake = fakeFactory(commands);
  const s = new ClaudeCodeSession({ cwd: dir, catalogOnly: true }, () => {}, fake.factory);
  try {
    await s.start();
    assert.deepEqual((await s.send({ type: "get_skill_commands" })).commands, commands);
    assert.equal(fake.options.persistSession, false);
    assert.equal(s.sessionFile, "");
    assert.equal(fake.prompts.length, 0);
    await assert.rejects(s.send({ type: "prompt", message: "must not send" }), /Catalog clients/);
  } finally { await s.shutdown(); }
}));

test("an advertised Claude slash command reaches the native SDK unchanged", async () => fixture(async ({ dir }) => {
  const fake = fakeFactory([
    { name: "review", description: "Review project changes", argumentHint: "<path>" },
  ]);
  const s = new ClaudeCodeSession({ cwd: dir }, () => {}, fake.factory);
  try {
    await s.start();
    await s.send({ type: "prompt", message: "/review src/example.ts" });
    await tick();
    assert.equal(fake.prompts.length, 1);
    assert.equal(fake.prompts[0].message.content[0].text, "/review src/example.ts");
    assert.equal(s.isRunning(), true);
    fake.frame({ type: "result", session_id: nativeSessionId(s.sessionId), is_error: false });
    await tick();
    assert.equal(s.isRunning(), false);
  } finally { await s.shutdown(); }
}));

test("Claude local slash-command output is displayed once as assistant text", () => {
  const p = new ClaudeEventProjector("native-model");
  const frame = {
    type: "system", subtype: "local_command_output", session_id: "s",
    uuid: "local-command-1", content: "Native command output",
  };
  const events = p.consume(frame);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "message_end");
  assert.equal(events[0].message.role, "assistant");
  assert.deepEqual(events[0].message.content, [{ type: "text", text: "Native command output" }]);
  assert.deepEqual(p.consume(frame), []);
});

test("Claude catalog preserves builtin/name precedence, aliases, and terminal restrictions", () => {
  const command = (name, extra = {}) => ({ name, description: name, argumentHint: "", ...extra });
  const rows = claudeSlashCommands([
    command("usage", { builtin: true, aliases: ["cost", "stats"] }),
    command("usage", { description: "shadowed user skill" }),
    command("cost", { description: "named user skill wins over alias" }),
    command("login", { aliases: ["signin"] }),
    command("fork", { aliases: ["duplicate"] }),
    command("exit"), command("statusline"), command("terminal-only", { aliases: ["terminal-alias"] }),
    command("bad name"), command("/invalid"), command("compact"),
  ], ["terminal-only"]);
  assert.deepEqual(rows.map((row) => row.name), ["usage", "stats", "cost", "compact"]);
  assert.equal(rows.find((row) => row.name === "usage").description, "usage");
  assert.equal(rows.find((row) => row.name === "cost").description, "named user skill wins over alias");
  assert.equal(rows.find((row) => row.name === "stats").description, "usage");
});

test("unknown or terminal-only Claude commands never become model prompts", async () => fixture(async ({ dir }) => {
  const commands = [{ name: "usage", description: "Usage", argumentHint: "" }];
  const fake = fakeFactory(commands);
  const s = new ClaudeCodeSession({ cwd: dir }, () => {}, fake.factory);
  try {
    await s.start();
    for (const message of ["/unknown", "/", "/login", "/logout", "/clear", "/fork", "/exit"]) {
      await assert.rejects(s.send({ type: "prompt", message }));
    }
    assert.equal(fake.prompts.length, 0);
    assert.equal(s.isRunning(), false);
    // SDK catalog changes are visible on the next request (no web lifetime cache).
    commands.push({ name: "later-skill", description: "Newly discovered", argumentHint: "" });
    assert.equal((await s.send({ type: "get_commands" })).commands.length, 2);
    fake.frame({ type: "system", subtype: "init", session_id: nativeSessionId(s.sessionId), tools: [], model: "m", terminal_slash_commands: ["later-skill"] });
    await tick();
    assert.deepEqual((await s.send({ type: "get_commands" })).commands.map((row) => row.name), ["usage"]);
    await assert.rejects(s.send({ type: "prompt", message: "/later-skill" }), /not available/);
    assert.equal(fake.prompts.length, 0);
  } finally { await s.shutdown(); }
}));

test("Claude local command output is persisted but only its result settles the turn", async () => fixture(async ({ dir }) => {
  const fake = fakeFactory([{ name: "usage", description: "Usage", argumentHint: "" }]);
  const s = new ClaudeCodeSession({ cwd: dir }, () => {}, fake.factory);
  try {
    await s.start();
    await s.send({ type: "prompt", message: "/usage" });
    fake.frame({ type: "system", subtype: "local_command_output", session_id: nativeSessionId(s.sessionId), uuid: "local-1", content: "Synthetic usage output" });
    await tick();
    assert.equal(s.isRunning(), true);
    assert.equal((await s.send({ type: "get_last_assistant_text" })).text, "Synthetic usage output");
    assert.ok((await readFile(s.sessionFile, "utf8")).includes("Synthetic usage output"));
    fake.frame({ type: "result", session_id: nativeSessionId(s.sessionId), is_error: false });
    await tick();
    assert.equal(s.isRunning(), false);
  } finally { await s.shutdown(); }
}));

test("a delayed Claude command catalog cannot enqueue a second concurrent prompt", async () => fixture(async ({ dir }) => {
  let resolveCatalog;
  const fake = fakeFactory(new Promise((resolve) => { resolveCatalog = resolve; }));
  const s = new ClaudeCodeSession({ cwd: dir }, () => {}, fake.factory);
  try {
    await s.start();
    const slash = s.send({ type: "prompt", message: "/review" });
    await tick();
    await s.send({ type: "prompt", message: "ordinary prompt" });
    const rejected = assert.rejects(slash, /busy/);
    resolveCatalog([{ name: "review", description: "Review", argumentHint: "" }]);
    await rejected;
    await tick();
    assert.equal(fake.prompts.length, 1);
    assert.equal(fake.prompts[0].message.content[0].text, "ordinary prompt");
  } finally { await s.shutdown(); }
}));

test("tool calls/results map to the existing web event contract", () => {
  const p = new ClaudeEventProjector("m");
  const events = p.consume({ type: "assistant", uuid: "call", message: { content: [{ type: "tool_use", id: "t", name: "Read", input: { file_path: "README.md" } }] } });
  assert.equal(events[0].message.content[0].toolName, "Read");
  assert.equal(events[1].type, "tool_execution_start");
  const result = p.consume({ type: "user", uuid: "result", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "hello" }] } });
  assert.equal(result[0].type, "tool_execution_end");
  assert.equal(result[1].message.role, "toolResult");
  assert.equal(result[1].message.toolName, "Read");
});

test("Claude accepts a steer while the current turn is running without interrupting it", async () => fixture(async ({ dir }) => {
  const fake = fakeFactory();
  const s = new ClaudeCodeSession({ cwd: dir }, () => {}, fake.factory);
  try {
    await s.start();
    await s.send({ type: "prompt", message: "first request" });
    fake.frame({ type: "system", subtype: "init", session_id: nativeSessionId(s.sessionId), tools: [], model: "test-native-model", capabilities: ["msg_lifecycle_v1", "request_marker_lists_v1", "interrupt_cancel_queued_v1"] });
    await tick();
    await s.send({ type: "steer", message: "additional instruction" });
    await tick();
    assert.equal(fake.prompts.length, 2);
    assert.equal(fake.prompts[1].message.content[0].text, "additional instruction");
    assert.equal(fake.interrupts, 0);
    assert.equal(fake.prompts[1].priority, "next");
    assert.equal(s.isRunning(), true);
  } finally { await s.shutdown(); }
}));

const steeringCapabilities = ["msg_lifecycle_v1", "request_marker_lists_v1", "interrupt_cancel_queued_v1"];
async function startSteeringSession(dir, fake) {
  const s = new ClaudeCodeSession({ cwd: dir }, () => {}, fake.factory);
  await s.start();
  await s.send({ type: "prompt", message: "initial" });
  fake.frame({ type: "system", subtype: "init", session_id: nativeSessionId(s.sessionId), tools: [], model: "test-native-model", capabilities: steeringCapabilities });
  await tick();
  return s;
}

test("Claude mixed steer/follow-up sends settle by consumed UUIDs, not queue counts or latest send", async () => fixture(async ({ dir }) => {
  const fake = fakeFactory(), s = await startSteeringSession(dir, fake), events = [];
  s.onEvent(event => events.push(event));
  try {
    await s.send({ type: "follow_up", message: "later input" });
    await s.send({ type: "steer", message: "steer input" });
    await tick();
    const [a, b, c] = fake.prompts.map(p => p.uuid);
    assert.equal(fake.prompts[1].priority, "later");
    assert.equal(fake.prompts[2].priority, "next");
    assert.deepEqual((await s.send({ type: "get_state" })).queuedMessages, { steering: ["steer input"], followUp: ["later input"] });
    assert.ok(!(await readFile(s.sessionFile, "utf8")).includes("steer input"));
    fake.frame({ type: "command_lifecycle", command_uuid: c, state: "started" });
    fake.frame({ type: "command_lifecycle", command_uuid: c, state: "completed" });
    fake.frame({ type: "result", uuid: "r1", user_message_uuid: a, user_message_uuids: [a, c], queued_turn_count: 0, is_error: false });
    await tick();
    assert.equal(s.isRunning(), true);
    assert.equal(events.filter(e => e.type === "agent_end").length, 0);
    assert.ok((await readFile(s.sessionFile, "utf8")).includes("steer input"));
    assert.ok(!(await readFile(s.sessionFile, "utf8")).includes("later input"));
    fake.frame({ type: "result", uuid: "r1", user_message_uuid: a, is_error: false });
    fake.frame({ type: "result", uuid: "foreign", user_message_uuid: a, is_error: false });
    await tick();assert.equal(s.isRunning(), true);
    fake.frame({ type: "command_lifecycle", command_uuid: b, state: "started" });
    fake.frame({ type: "result", uuid: "r2", user_message_uuid: b, is_error: false });
    await tick();
    assert.equal(s.isRunning(), false);
    assert.equal(events.filter(e => e.type === "agent_end").length, 1);
    assert.equal(events.filter(e => e.type === "message_end" && e.message.role === "user").length, 2);
  } finally { await s.shutdown(); }
}));

test("Claude steering does not reset partial text or pending approval deduplication, and reconnect replays the queue", async () => fixture(async ({ dir }) => {
  const fake = fakeFactory(), s = await startSteeringSession(dir, fake), events = [];
  s.onEvent(e => events.push(e));
  try {
    const controller = new AbortController(), context = { signal: controller.signal, toolUseID: "t", requestId: "permission" };
    const permission = fake.options.canUseTool("Write", { file_path: "fixture" }, context);
    fake.frame({ type: "stream_event", event: { type: "message_start" } });
    fake.frame({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "before" } } });
    await tick();await s.send({ type: "steer", message: "change instruction" });
    assert.equal(fake.options.canUseTool("Write", { file_path: "fixture" }, context), permission);
    fake.frame({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " after" } } });
    await tick();assert.equal(events.filter(e => e.type === "message_update").at(-1).message.content[0].text, "before after");
    const replay=[];s.onEvent(e=>replay.push(e));assert.ok(replay.some(e=>e.type==='agent_capabilities'&&e.supportsSteering));assert.ok(replay.some(e=>e.type==='queue_update'&&e.steering[0]==='change instruction'));
    assert.ok(replay.some(e=>e.type==='extension_ui_request'&&e.method==='select'));
    controller.abort();assert.equal((await permission).behavior,'deny');
  } finally { await s.shutdown(); }
}));

test("Claude Stop requests native queue cancellation and waits for the active result", async () => fixture(async ({ dir }) => {
  const fake = fakeFactory([], async()=>({}), async()=>({still_queued:[],cancelled:[fake.prompts[1].uuid]}));
  const s = await startSteeringSession(dir,fake);
  try {
    const a=fake.prompts[0].uuid;
    fake.frame({type:'command_lifecycle',command_uuid:a,state:'started'});await tick();
    await s.send({type:'follow_up',message:'must not run after stop'});await tick();
    await s.send({type:'abort'});assert.deepEqual(fake.interruptOptions,[{cancelQueued:true}]);assert.equal(s.isRunning(),true);
    await s.send({type:'abort'});assert.equal(fake.interrupts,1,'repeated Stop must not install another watchdog');
    await assert.rejects(s.send({type:'steer',message:'during stop'}),/stopping|busy/);
    fake.frame({type:'result',user_message_uuid:a,is_error:false});await tick();assert.equal(s.isRunning(),false);
    assert.ok(!(await readFile(s.sessionFile,'utf8')).includes('must not run after stop'));
  } finally {await s.shutdown();}
}));

test("unconfirmed Claude cancellation closes the query instead of letting queued input survive", async () => fixture(async ({dir})=>{
  const fake=fakeFactory(),s=await startSteeringSession(dir,fake),events=[];s.onEvent(e=>events.push(e));
  try {await s.send({type:'steer',message:'pending'});await tick();await s.send({type:'abort'});assert.equal(s.isAlive(),false);assert.ok(events.some(e=>e.type==='agent_closed'));}
  finally{await s.shutdown();}
}));

test("Claude streaming input fails explicitly without capabilities or for commands/images",async()=>fixture(async({dir})=>{
 const fake=fakeFactory(),s=new ClaudeCodeSession({cwd:dir},()=>{},fake.factory);
 try{await s.start();await assert.rejects(s.send({type:'steer',message:'x'}),/advertised/);
 await s.send({type:'prompt',message:'first'});fake.frame({type:'system',subtype:'init',session_id:nativeSessionId(s.sessionId),tools:[],model:'m',capabilities:steeringCapabilities});await tick();
 await assert.rejects(s.send({type:'steer',message:'/model'}),/plain text/);
 await assert.rejects(s.send({type:'follow_up',message:'x',images:[{type:'image',mimeType:'image/png',data:'eA=='}]}),/plain text/);
 await assert.rejects(s.send({type:'prompt',message:'x',streamingBehavior:'unknown'}),/Invalid streaming/);
 assert.equal(fake.prompts.length,1);
 }finally{await s.shutdown();}
}));

test("Claude pending input is bounded and an idle steer race starts an ordinary turn",async()=>fixture(async({dir})=>{
 const fake=fakeFactory(),s=await startSteeringSession(dir,fake);
 try{
  await assert.rejects(s.send({type:'steer',message:'x'.repeat(65537)}),/limit/);
  for(let i=0;i<31;i++)await s.send({type:'steer',message:'same text'});
  await assert.rejects(s.send({type:'steer',message:'overflow'}),/limit/);await tick();
  const ids=fake.prompts.map(p=>p.uuid);assert.equal(new Set(ids).size,32);
  fake.frame({type:'result',user_message_uuid:ids[0],user_message_uuids:ids,is_error:false});await tick();assert.equal(s.isRunning(),false);
  await s.send({type:'steer',message:'arrived after settlement'});await tick();assert.equal(s.isRunning(),true);assert.equal(fake.prompts.at(-1).priority,undefined);
 }finally{await s.shutdown();}
}));

test("Claude recalls one pending UUID only after native confirmation, without stopping or resending", async () => fixture(async ({ dir }) => {
  const fake = fakeFactory([], async()=>({}), async()=>undefined, async request=>({response:{cancelled:true}}));
  const s = await startSteeringSession(dir, fake);
  try {
    await s.send({type:'follow_up',message:'edit this'});await tick();
    const item=(await s.send({type:'get_state'})).queuedItems[0];assert.equal(item.text,'edit this');
    const reply=await s.send({type:'recall_queued_message',id:item.id});assert.equal(reply.removed,true);assert.equal(reply.text,'edit this');
    assert.deepEqual(fake.controlRequests,[{subtype:'cancel_async_message',message_uuid:item.id}]);
    assert.equal(fake.interrupts,0);assert.equal(fake.prompts.length,2);assert.equal(s.isRunning(),true);
    assert.equal((await s.send({type:'get_state'})).queuedItems.length,0);
  } finally {await s.shutdown();}
}));

test("Claude does not claim to edit started or unconfirmed messages",async()=>fixture(async({dir})=>{
 const fake=fakeFactory(),s=await startSteeringSession(dir,fake);
 try{
  await s.send({type:'steer',message:'pending'});await tick();const id=fake.prompts[1].uuid;
  assert.equal((await s.send({type:'recall_queued_message',id})).removed,false);assert.equal((await s.send({type:'get_state'})).queuedItems.length,1);
  fake.frame({type:'command_lifecycle',state:'started',command_uuid:id});await tick();
  assert.equal((await s.send({type:'recall_queued_message',id})).removed,false);assert.equal(fake.controlRequests.length,1);
  assert.equal(fake.interrupts,0);assert.equal(fake.prompts.length,2);
 }finally{await s.shutdown();}
}));

test("a queued input that starts during recall handoff is not cancelled or claimed as editable",async()=>fixture(async({dir})=>{
 const fake=fakeFactory([],async()=>({}),async()=>undefined,async()=>({response:{cancelled:true}})),s=await startSteeringSession(dir,fake);
 try{
  await s.send({type:'steer',message:'racing'});await tick();const id=fake.prompts[1].uuid;
  const recalling=s.send({type:'recall_queued_message',id});
  fake.frame({type:'command_lifecycle',state:'started',command_uuid:id});
  assert.equal((await recalling).removed,false);assert.equal(fake.controlRequests.length,0);assert.equal(fake.interrupts,0);
 }finally{await s.shutdown();}
}));

test("web turn, interrupt and resume use exact native UUID; no queued second prompt", async () => fixture(async ({ dir }) => {
  const fake = fakeFactory();
  const s = new ClaudeCodeSession({ cwd: dir }, () => {}, fake.factory);
  const events = [];
  s.onEvent((event) => events.push(event));
  try {
    await s.start();
    const id = nativeSessionId(s.sessionId);
    assert.equal(fake.options.sessionId, id);
    assert.equal(fake.options.permissionMode, undefined);
    assert.equal(fake.options.allowDangerouslySkipPermissions, undefined);
    assert.deepEqual(fake.options.settingSources, ["user", "project", "local"]);
    assert.equal(fake.options.settings, undefined);
    assert.equal(fake.options.mcpServers, undefined);
    assert.equal(fake.options.model, undefined);
    await s.send({ type: "prompt", message: "hello" });
    await assert.rejects(s.send({ type: "prompt", message: "concurrent" }), /busy/);
    await tick();
    assert.equal(fake.prompts[0].session_id, id);
    await s.send({ type: "abort" });
    assert.equal(fake.interrupts, 1);
    assert.equal(s.isRunning(), true);
    fake.frame(assistant(id, "reply"));
    fake.frame({ type: "result", session_id: id, is_error: false });
    await tick();
    assert.equal(s.isRunning(), false);
    assert.deepEqual(events.slice(-3).map((e) => e.type), ["agent_end", "prompt_done", "agent_settled"]);
    const file = s.sessionFile;
    const saved = await readFile(file, "utf8");
    assert.ok(saved.includes("reply"));
    assert.ok(!saved.includes("fake-local-proxy-key"));
    await s.shutdown();
    const resumed = fakeFactory();
    const other = new ClaudeCodeSession({ cwd: dir, sessionFile: file, nativeId: id }, () => {}, resumed.factory);
    try {
      await other.start();
      assert.equal(resumed.options.resume, id);
      assert.equal(resumed.options.sessionId, undefined);
      assert.equal(other.sessionId, s.sessionId);
    } finally { await other.shutdown(); }
  } finally { await s.shutdown(); }
}));

test("permissions replay on reconnect, deduplicate requests and deny on cancellation", async () => fixture(async ({ dir }) => {
  const fake = fakeFactory();
  const s = new ClaudeCodeSession({ cwd: dir }, () => {}, fake.factory);
  try {
    await s.start();
    const signal = new AbortController();
    const context = { signal: signal.signal, toolUseID: "tool", requestId: "permission" };
    const first = fake.options.canUseTool("Bash", { command: "pwd" }, context);
    const duplicate = fake.options.canUseTool("Bash", { command: "pwd" }, context);
    assert.equal(first, duplicate);
    const replay = [];
    const unsubscribe = s.onEvent((e) => { if (e.type === "extension_ui_request") replay.push(e); });
    assert.equal(replay.length, 1);
    assert.deepEqual(replay[0].options, ["Deny", "Allow once"]);
    unsubscribe();
    const reconnected = [];
    s.onEvent((e) => { if (e.type === "extension_ui_request") reconnected.push(e); });
    assert.equal(reconnected[0].id, replay[0].id);
    await s.send({ type: "extension_ui_response", id: replay[0].id, value: "Allow once" });
    assert.equal((await first).behavior, "allow");
    const pending = fake.options.canUseTool("Write", { file_path: "x" }, { ...context, requestId: "cancel" });
    signal.abort();
    assert.equal((await pending).behavior, "deny");
    const empty = [];
    s.onEvent((e) => { if (e.type === "extension_ui_request") empty.push(e); });
    assert.equal(empty.length, 0);
  } finally { await s.shutdown(); }
}));

test("an explicit interrupt normalizes only the CLI abort diagnostic, not real errors", async () => fixture(async ({ dir }) => {
  const fake = fakeFactory();
  const s = new ClaudeCodeSession({ cwd: dir }, () => {}, fake.factory);
  const events = [];
  s.onEvent((e) => events.push(e));
  try {
    await s.start();
    await s.send({ type: "prompt", message: "stop this turn" });
    await s.send({ type: "abort" });
    fake.frame({ type: "result", session_id: nativeSessionId(s.sessionId), subtype: "error_during_execution", is_error: true, errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"] });
    await tick();
    assert.ok(!events.some((e) => e.type === "prompt_error"));
    assert.equal(s.isRunning(), false);
    events.length = 0;
    await s.send({ type: "prompt", message: "another turn" });
    await s.send({ type: "abort" });
    fake.frame({ type: "result", session_id: nativeSessionId(s.sessionId), subtype: "error_during_execution", is_error: true, errors: ["authentication_failed"] });
    await tick();
    assert.ok(events.some((e) => e.type === "prompt_error" && e.errorMessage === "authentication_failed"));
  } finally { await s.shutdown(); }
}));

test("AskUserQuestion answers survive browser dialogs and cancellation never grants permission", async () => fixture(async ({ dir }) => {
  const fake = fakeFactory();
  const s = new ClaudeCodeSession({ cwd: dir }, () => {}, fake.factory);
  const events = [];
  s.onEvent((e) => events.push(e));
  try {
    await s.start();
    const controller = new AbortController();
    const pending = fake.options.canUseTool("AskUserQuestion", { questions: [{ question: "Which option?", options: [{ label: "A", description: "first" }, { label: "B", description: "second" }] }] }, { signal: controller.signal, toolUseID: "question", requestId: "question" });
    const dialog = events.find((e) => e.type === "extension_ui_request" && e.method === "input");
    assert.ok(dialog.title.includes("Which option?"));
    await s.send({ type: "extension_ui_response", id: dialog.id, value: "A" });
    const reply = await pending;
    assert.equal(reply.behavior, "allow");
    assert.deepEqual(reply.updatedInput.answers, { "Which option?": "A" });
  } finally { await s.shutdown(); }
}));

test("native identity changes and unsupported commands fail explicitly", async () => fixture(async ({ dir }) => {
  const fake = fakeFactory();
  const s = new ClaudeCodeSession({ cwd: dir }, () => {}, fake.factory);
  try {
    await s.start();
    for (const type of ["fork", "navigate_tree", "bash", "set_thinking_level", "compact"]) {
      await assert.rejects(s.send({ type }), /does not support/);
    }
    await assert.rejects(s.send({ type: "prompt", message: "/login" }), /slash commands/);
    fake.frame(assistant("wrong-id", "must not be written"));
    await tick();
    assert.equal(s.isAlive(), false);
    assert.ok(!(await readFile(s.sessionFile, "utf8")).includes("must not be written"));
  } finally { await s.shutdown(); }
}));
