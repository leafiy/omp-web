import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { ClaudeCodeSession } = await jiti.import("./claude-code-session.ts");
const { ClaudeWebTranscript } = await jiti.import("./claude-code-store.ts");
const { ClaudeSystemEvents } = await jiti.import("./claude-system-events.ts");
const { resolveNativeTarget } = await jiti.import("./claude-rewind.ts");
const { elicitationFields, parseElicitationAnswer, safeElicitationUrl } = await jiti.import("./claude-elicitation.ts");
const { projectMcpStatus } = await jiti.import("./claude-mcp.ts");
const { claudeToolResultDiff } = await jiti.import("./claude-code-events.ts");
const { claudeInputDiff, todoItems } = await jiti.import("./tool-input-diff.ts");
const { renderSessionHtml } = await jiti.import("./session-html-export.ts");
const { nativeSessionId } = await jiti.import("./engine.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), "omp-web-cc-advanced-"));
  const env = { OMP_WEB_CC_EXECUTABLE: "/fake/claude", OMP_WEB_CC_STATE_DIR: dir };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try { await run({ dir }); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

/** Fake SDK query: no CLI, no model. Records native control calls. */
function fakeFactory({ rewind = async () => ({ canRewind: true, filesChanged: [], insertions: 0, deletions: 0 }) } = {}) {
  let captured, resolveNext, ended = false;
  const pending = [], prompts = [], calls = [];
  const q = {
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (pending.length) return Promise.resolve({ value: pending.shift(), done: false });
      if (ended) return Promise.resolve({ done: true });
      return new Promise((resolve) => { resolveNext = resolve; });
    },
    initializationResult: async () => ({}),
    supportedModels: async () => [],
    supportedCommands: async () => [],
    request: async (request) => {
      if (request.subtype === "list_models") return { response: { models: [] } };
      throw new Error(`Unknown control request subtype: ${request.subtype}`);
    },
    getContextUsage: async () => ({}),
    setModel: async () => {},
    setPermissionMode: async (mode) => { calls.push(["setPermissionMode", mode]); },
    rewindFiles: async (uuid, options) => { calls.push(["rewindFiles", uuid, options?.dryRun === true]); return rewind(uuid, options); },
    stopTask: async (id) => { calls.push(["stopTask", id]); },
    mcpServerStatus: async () => [{ name: "docs", status: "connected", config: { type: "http", url: "https://x.test/?token=secret", headers: { Authorization: "Bearer secret" } }, tools: [{ name: "search", annotations: { readOnly: true } }] }],
    reconnectMcpServer: async (name) => { calls.push(["reconnect", name]); },
    toggleMcpServer: async (name, enabled) => { calls.push(["toggle", name, enabled]); },
    interrupt: async () => undefined,
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
    calls,
  };
}

async function turn(session, fake, message, assistantUuid) {
  await session.send({ type: "prompt", message });
  await tick();
  const prompt = fake.prompts.at(-1);
  fake.frame({ type: "assistant", parent_tool_use_id: null, uuid: assistantUuid, message: { model: "m", content: [{ type: "text", text: `re: ${message}` }] } });
  fake.frame({ type: "result", uuid: `result-${assistantUuid}`, subtype: "success", is_error: false, user_message_uuid: prompt.uuid });
  for (let i = 0; i < 5; i++) await tick();
  return prompt.uuid;
}

test("projection branches on rewind and records the pending native resume point", async () => fixture(async ({ dir }) => {
  const id = "11111111-1111-4111-8111-111111111111";
  const t = new ClaudeWebTranscript(id, dir);
  t.append({ role: "user", content: [{ type: "text", text: "one" }] }, "u1");
  t.append({ role: "assistant", content: [{ type: "text", text: "a" }], model: "m", provider: "claude-code" });
  t.append({ role: "user", content: [{ type: "text", text: "two" }] }, "u2");
  t.append({ role: "assistant", content: [{ type: "text", text: "b" }], model: "m", provider: "claude-code" });
  const target = t.getProjectedMessages()[2];
  assert.equal(target.nativeUuid, "u2");
  t.rewindBefore(target.entryId, { resumeSessionAt: "a1", nativeUuid: "u2" });
  const reopened = new ClaudeWebTranscript(id, dir, t.path);
  assert.deepEqual(reopened.getMessages().map((m) => m.content[0].text), ["one", "a"]);
  assert.equal(reopened.pendingResumeAt, "a1");
  reopened.append({ role: "user", content: [{ type: "text", text: "again" }] }, "u3");
  assert.equal(reopened.pendingResumeAt, "a1", "a user send alone does not commit the native branch");
  reopened.append({ role: "assistant", content: [{ type: "text", text: "c" }], model: "m", provider: "claude-code" });
  assert.equal(reopened.pendingResumeAt, undefined);
  assert.deepEqual(new ClaudeWebTranscript(id, dir, t.path).getMessages().map((m) => m.content[0].text), ["one", "a", "again", "c"]);
}));

test("native targets match by UUID, then by unambiguous text, never by guess", () => {
  const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
  const projected = [{ entryId: "e1", message: user("hi") }, { entryId: "e2", message: user("go"), nativeUuid: "n2" }, { entryId: "e3", message: user("hi") }];
  const chain = [{ type: "user", uuid: "n1", message: { content: "hi" } }, { type: "assistant", uuid: "a1", message: {} }, { type: "user", uuid: "n2", message: { content: "go" } }, { type: "user", uuid: "n3", message: { content: [{ type: "text", text: "hi" }] } }];
  assert.deepEqual(resolveNativeTarget(projected, "e2", chain), { index: 2, uuid: "n2", position: 1 });
  assert.deepEqual(resolveNativeTarget(projected, "e3", chain), { index: 3, uuid: "n3", position: 2 });
  assert.throws(() => resolveNativeTarget(projected, "e3", chain.slice(0, 3)), /more than once/);
  assert.throws(() => resolveNativeTarget([{ entryId: "x", message: user("lost") }], "x", chain), /not in Claude Code's active native history/);
});

test("system frames map to compaction, retry, hook and notice events", () => {
  const events = new ClaudeSystemEvents();
  assert.equal(events.consume({ type: "system", subtype: "status", status: "compacting" })[0].type, "compaction_start");
  assert.equal(events.isCompacting, true);
  const end = events.consume({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 9000, post_tokens: 1200 } });
  assert.deepEqual(end[0], { type: "compaction_end", reason: "manual", result: { tokensBefore: 9000, estimatedTokensAfter: 1200 } });
  assert.equal(events.isCompacting, false);
  assert.equal(events.consume({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 5, retry_delay_ms: 3000, error_status: 529, error: "overloaded" })[0].type, "auto_retry_start");
  assert.equal(events.consume({ type: "stream_event", event: {} })[0].type, "auto_retry_end");
  const started = events.consume({ type: "system", subtype: "hook_started", hook_id: "h", hook_event: "PreToolUse", hook_name: "lint" });
  assert.equal(started[0].method, "setStatus");
  const response = events.consume({ type: "system", subtype: "hook_response", hook_id: "h", hook_event: "PreToolUse", hook_name: "lint", outcome: "error", exit_code: 2, stderr: "blocked", stdout: "", output: "" });
  assert.equal(response[0].statusText, undefined);
  assert.match(response[1].message, /lint failed \(exit 2\): blocked/);
  assert.deepEqual(events.consume({ type: "system", subtype: "hook_started", hook_id: "child", parent_tool_use_id: "agent" }), []);
});

test("elicitation forms parse supported schemas and reject unsupported ones", () => {
  const fields = elicitationFields({ type: "object", required: ["name"], properties: { name: { type: "string", title: "Name" }, size: { type: "integer", minimum: 1 }, color: { type: "string", enum: ["r", "g"], enumNames: ["Red", "Green"] }, ok: { type: "boolean" }, tags: { type: "array", items: { enum: ["a", "b"] } } } });
  assert.deepEqual(fields.map((f) => [f.key, f.kind, f.required]), [["name", "string", true], ["size", "integer", false], ["color", "enum", false], ["ok", "boolean", false], ["tags", "multi", false]]);
  assert.equal(parseElicitationAnswer(fields[1], "3"), 3);
  assert.throws(() => parseElicitationAnswer(fields[1], "0"), /at least 1/);
  assert.deepEqual(parseElicitationAnswer(fields[4], "a, b"), ["a", "b"]);
  assert.equal(elicitationFields({ type: "object", properties: { nested: { type: "object" } } }), undefined);
  assert.equal(safeElicitationUrl("javascript:alert(1)"), undefined);
  assert.equal(safeElicitationUrl("https://auth.example/x"), "https://auth.example/x");
});

test("MCP status never exposes commands, URLs, headers or env", () => {
  const [server] = projectMcpStatus([{ name: "docs", status: "connected", scope: "project", config: { type: "http", url: "https://x/?token=secret", headers: { a: "secret" } }, tools: [{ name: "search", annotations: { readOnly: true } }] }]);
  assert.deepEqual(server, { name: "docs", status: "connected", scope: "project", transport: "http", tools: [{ name: "search", readOnly: true }] });
  assert.ok(!JSON.stringify(server).includes("secret"));
});

test("tool display uses native structured patches, input fallbacks and todo lists", () => {
  const diff = claudeToolResultDiff({ filePath: "/p/a.ts", structuredPatch: [{ oldStart: 4, oldLines: 1, newStart: 4, newLines: 1, lines: ["-old", "+new"] }] });
  assert.equal(diff, "--- /p/a.ts\n+++ /p/a.ts\n@@ -4,1 +4,1 @@\n-old\n+new");
  assert.equal(claudeToolResultDiff({ type: "create", filePath: "/p/n.ts", content: "x\ny\n", structuredPatch: [] }), "--- /dev/null\n+++ /p/n.ts\n@@ -0,0 +1,2 @@\n+x\n+y");
  assert.equal(claudeInputDiff("Edit", { file_path: "a", old_string: "a\nb", new_string: "c" }), "-a\n-b\n+c");
  assert.equal(claudeInputDiff("edit", { old_string: "a", new_string: "b" }), null, "OMP tools keep their native diff details");
  assert.deepEqual(todoItems("TodoWrite", { todos: [{ content: "x", status: "in_progress", activeForm: "Doing x" }, { content: "y", status: "weird" }] }), [{ content: "x", status: "in_progress", activeForm: "Doing x" }, { content: "y", status: "pending" }]);
});

test("HTML export escapes content and inlines only validated images", () => {
  const html = renderSessionHtml({ title: "<t>", engineLabel: "Claude Code", cwd: "/p", messages: [
    { role: "user", content: [{ type: "text", text: "<script>alert(1)</script>" }, { type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "PHN2Zz4=" } }] },
    { role: "assistant", model: "m", provider: "claude-code", content: [{ type: "text", text: "```js\nlet a = '<b>';\n```" }] },
  ] });
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("image/svg+xml;base64"));
  assert.ok(html.includes('<pre class="code" data-lang="js"><code>let a = &#39;&lt;b&gt;&#39;;</code></pre>'));
});

test("approvals offer Claude's own always-allow suggestions and ExitPlanMode sets the mode", async () => fixture(async ({ dir }) => {
  const fake = fakeFactory();
  const s = new ClaudeCodeSession({ cwd: dir }, () => {}, fake.factory);
  try {
    await s.start();
    const dialogs = [];
    s.onEvent((e) => { if (e.type === "extension_ui_request" && e.method === "select") dialogs.push(e); });
    const suggestions = [{ type: "addRules", behavior: "allow", destination: "localSettings", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }] }, { type: "removeRules", behavior: "allow", destination: "session", rules: [] }];
    const reply = fake.options.canUseTool("Bash", { command: "npm test" }, { signal: new AbortController().signal, toolUseID: "t1", requestId: "r1", suggestions });
    await tick();
    assert.deepEqual(dialogs[0].options, ["Deny", "Allow once", "Always allow in this session: Bash(npm test:*)", "Always allow (save to project local settings): Bash(npm test:*)"]);
    await s.send({ type: "extension_ui_response", id: dialogs[0].id, value: dialogs[0].options[2] });
    const result = await reply;
    assert.equal(result.behavior, "allow");
    assert.deepEqual(result.updatedPermissions, [{ ...suggestions[0], destination: "session" }], "removals are never applied and the scope is narrowed");
    const plan = fake.options.canUseTool("ExitPlanMode", { plan: "1. do it" }, { signal: new AbortController().signal, toolUseID: "t2", requestId: "r2" });
    await tick();
    await s.send({ type: "extension_ui_response", id: dialogs[1].id, value: "Approve and auto-accept edits" });
    assert.deepEqual((await plan).updatedPermissions, [{ type: "setMode", mode: "acceptEdits", destination: "session" }]);
    await assert.rejects(s.send({ type: "set_permission_mode", mode: "bypassPermissions" }), /Unsupported/);
    await s.send({ type: "set_permission_mode", mode: "plan" });
    assert.deepEqual(fake.calls.at(-1), ["setPermissionMode", "plan"]);
    assert.equal((await s.send({ type: "get_state" })).permissionMode, "plan");
    const mcp = await s.send({ type: "get_mcp_status" });
    assert.ok(!JSON.stringify(mcp).includes("secret"));
    await assert.rejects(s.send({ type: "mcp_reconnect", name: "unknown" }), /Unknown MCP server/);
  } finally { await s.shutdown(); }
}));

test("Fork copies the projection before the message; Rewind restores files and resumes at the native point", async () => fixture(async ({ dir }) => {
  const forkId = "22222222-2222-4222-8222-222222222222";
  const native = {
    chains: new Map(),
    async messages(id) { return native.chains.get(id) ?? []; },
    async fork(id, cwd, upTo) { native.forked = { id, cwd, upTo }; return forkId; },
  };
  const fake = fakeFactory({ rewind: async (uuid, options) => ({ canRewind: true, filesChanged: [join(dir, "a.ts")], insertions: 1, deletions: 2, ...(options?.dryRun ? {} : { skippedLinks: 0 }) }) });
  const s = new ClaudeCodeSession({ cwd: dir }, () => {}, fake.factory, undefined, undefined, native);
  await s.start();
  const id = nativeSessionId(s.sessionId);
  const u1 = await turn(s, fake, "first", "a1");
  const u2 = await turn(s, fake, "second", "a2");
  native.chains.set(id, [{ type: "user", uuid: u1, message: {} }, { type: "assistant", uuid: "a1", message: {} }, { type: "user", uuid: u2, message: {} }, { type: "assistant", uuid: "a2", message: {} }]);
  native.chains.set(forkId, [{ type: "user", uuid: "f1", message: {} }, { type: "assistant", uuid: "f2", message: {} }]);
  const file = s.sessionFile;
  const second = new ClaudeWebTranscript(id, dir, file).getProjectedMessages().find((m) => m.nativeUuid === u2);

  const forked = await s.send({ type: "fork", entryId: second.entryId });
  assert.equal(forked.newSessionId, `claude:${forkId}`);
  assert.equal(native.forked.upTo, "a1", "Fork means before the chosen user message");
  const forkFile = join(dir, "sessions", `${forkId}.jsonl`);
  assert.equal(JSON.parse((await readFile(forkFile, "utf8")).split("\n")[0]).parentSession, file);
  const copy = new ClaudeWebTranscript(forkId, dir, forkFile).getProjectedMessages();
  assert.deepEqual(copy.map((m) => m.message.role), ["user", "assistant"]);
  assert.equal(copy[0].nativeUuid, "f1", "native UUIDs are remapped to the fork");

  const preview = await s.send({ type: "rewind_preview", entryId: second.entryId });
  assert.equal(preview.conversation.canRewind, true);
  assert.equal(preview.files.insertions, 1);
  const first = new ClaudeWebTranscript(id, dir, file).getProjectedMessages().find((m) => m.nativeUuid === u1);
  await assert.rejects(s.send({ type: "rewind", entryId: first.entryId, mode: "conversation" }), /first message/);
  const result = await s.send({ type: "rewind", entryId: second.entryId, mode: "both" });
  assert.equal(result.text, "second");
  assert.deepEqual(fake.calls.filter((c) => c[0] === "rewindFiles").map((c) => c.slice(1)), [[u2, true], [u2, false]]);
  assert.equal(s.isAlive(), false, "the live CLI still held later turns, so it was closed");

  const resumed = fakeFactory();
  const reopened = new ClaudeCodeSession({ cwd: dir, sessionFile: file, nativeId: id }, () => {}, resumed.factory, undefined, undefined, native);
  try {
    await reopened.start();
    assert.equal(resumed.options.resume, id);
    assert.equal(resumed.options.resumeSessionAt, "a1");
    assert.equal(resumed.options.enableFileCheckpointing, true);
    assert.deepEqual((await reopened.send({ type: "get_messages" })).messages.map((m) => m.content[0].text), ["first", "re: first"]);
  } finally { await reopened.shutdown(); }
}));
