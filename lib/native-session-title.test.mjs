// Deterministic adapters only: no real CLI, model, credentials, or history is used.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { ClaudeCodeSession } = await jiti.import('./claude-code-session.ts');
const { CodexSession } = await jiti.import('./codex-session.ts');
const { CodexRpcClient } = await jiti.import('./codex-rpc-client.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));

async function workspace(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'native-title-test-'));
  const previous = { OMP_WEB_CC_EXECUTABLE: process.env.OMP_WEB_CC_EXECUTABLE, OMP_WEB_CC_STATE_DIR: process.env.OMP_WEB_CC_STATE_DIR, OMP_WEB_CODEX_STATE_DIR: process.env.OMP_WEB_CODEX_STATE_DIR };
  process.env.OMP_WEB_CC_EXECUTABLE = '/fake/native-claude';
  process.env.OMP_WEB_CC_STATE_DIR = join(cwd, 'claude-web');
  process.env.OMP_WEB_CODEX_STATE_DIR = join(cwd, 'codex-web');
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(cwd, { recursive: true, force: true });
  });
  return cwd;
}

function claudeQueries(titleFrames = [{ type: 'result', subtype: 'success', is_error: false, result: '  Native title  ' }], configureTitle = () => {}) {
  const calls = [], prompts = [];
  const factory = params => {
    const main = calls.length === 0, ended = Promise.withResolvers();
    const query = {
      closed: false,
      initializationResult: async () => ({}),
      close() { this.closed = true; ended.resolve(); },
      async *[Symbol.asyncIterator]() {
        if (main) { await ended.promise; return; }
        for await (const input of params.prompt) {
          prompts.push(input);
          yield { type: 'system', subtype: 'init', session_id: 'private-title', model: params.options.model, tools: [], ...query.init };
          for (const frame of titleFrames) yield frame;
          return;
        }
      },
    };
    if (!main) configureTitle(query);
    calls.push({ ...params, query });
    return query;
  };
  return { factory, calls, prompts };
}

async function claudeFixture(t, frames, configureTitle) {
  const cwd = await workspace(t), fake = claudeQueries(frames, configureTitle), events = [];
  const session = new ClaudeCodeSession({ cwd, initialModel: { provider: 'claude-code', modelId: 'selected-native-claude' } }, () => {}, fake.factory);
  session.onEvent(event => events.push(event));
  await session.start();
  t.after(() => session.destroy());
  return { session, fake, events, cwd };
}

test('Claude titles use a separate one-turn native query without tools, persistence, or main messages', async t => {
  const { session, fake, events, cwd } = await claudeFixture(t);
  const before = events.length;
  assert.equal(await session.generateSessionTitle('bounded plain-text prompt', new AbortController().signal), '  Native title  ');
  const options = fake.calls[1].options;
  assert.equal(options.cwd, cwd);
  assert.equal(options.env, fake.calls[0].options.env);
  assert.equal(options.pathToClaudeCodeExecutable, fake.calls[0].options.pathToClaudeCodeExecutable);
  assert.equal(options.model, 'selected-native-claude');
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.skills, []);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.persistSession, false);
  assert.equal(options.maxTurns, 1);
  assert.equal(options.verbatimPrompts, true);
  assert.equal(options.resume, undefined);
  assert.equal(options.sessionId, undefined);
  assert.equal(fake.calls[0].options.tools, undefined, 'main query behavior is unchanged');
  assert.equal(fake.prompts[0].message.content, 'bounded plain-text prompt');
  assert.equal(fake.calls[1].query.closed, true);
  assert.equal(fake.calls[0].query.closed, false);
  assert.equal(events.length, before);
  assert.deepEqual((await session.send({ type: 'get_messages' })).messages, []);
  assert.equal((await session.send({ type: 'get_state' })).sessionName, undefined);
});

test('Claude rejects advertised tools and never accepts a result from that query', async t => {
  const { session, fake } = await claudeFixture(t, undefined, query => { query.init = { tools: ['Bash'] }; });
  await assert.rejects(session.generateSessionTitle('title', new AbortController().signal), /disable every.*tool/);
  assert.equal(fake.calls[1].query.closed, true);
  assert.equal(fake.calls[0].query.closed, false);
});

test('Claude rejects tool-use frames instead of inventing a title', async t => {
  const { session } = await claudeFixture(t, [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } }]);
  await assert.rejects(session.generateSessionTitle('title', new AbortController().signal), /unexpected tool call/);
});

test('Claude cancellation closes a naming query even while initialization has not completed', async t => {
  const { session, fake } = await claudeFixture(t, undefined, query => {
    query.initializationResult = () => new Promise(() => {});
  });
  const controller = new AbortController(), generated = session.generateSessionTitle('title', controller.signal);
  await tick();
  controller.abort(new Error('naming cancelled'));
  await assert.rejects(generated, /naming cancelled/);
  assert.equal(fake.calls[1].query.closed, true);
  assert.equal(fake.calls[0].query.closed, false);
  assert.equal(fake.prompts.length, 0);
});

test('Claude native failures are errors, not candidate titles', async t => {
  const { session, fake } = await claudeFixture(t, [{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['native authentication failed'] }]);
  await assert.rejects(session.generateSessionTitle('title', new AbortController().signal), /native authentication failed/);
  assert.equal(fake.calls[1].query.closed, true);
});

test('Claude timeout terminates private initialization without closing the conversation', async t => {
  const { session, fake } = await claudeFixture(t, undefined, query => {
    query.initializationResult = () => new Promise(() => {});
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const generated = session.generateSessionTitle('title', new AbortController().signal);
  const rejected = assert.rejects(generated, /title generation timed out/);
  t.mock.timers.tick(90_000);
  await rejected;
  assert.equal(fake.calls[1].query.closed, true);
  assert.equal(fake.calls[0].query.closed, false);
});

class FakeCodex {
  id = randomUUID(); turn = randomUUID(); calls = []; closed = false; rejected = [];
  onFrame(fn) { this.listener = fn; }
  onClose(fn) { this.closedListener = fn; }
  async start() {}
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'config/read') return this.configGate ? await this.configGate.promise : { config: { mcp_servers: { 'native.with.dot': { command: 'must-not-run' }, required: { required: true } } } };
    if (method === 'thread/start') return {
      thread: { id: this.id, ephemeral: params.ephemeral === true, path: null, status: { type: 'idle' } },
      cwd: params.cwd, model: params.model || 'selected-native-codex', modelProvider: params.modelProvider || 'native-provider',
      sandbox: { type: 'readOnly' }, ...this.startResult,
    };
    if (method === 'thread/read') return { thread: { id: this.id, turns: [] } };
    if (method === 'model/list') return { data: [{ model: 'changed-native-codex' }], nextCursor: null };
    if (method === 'turn/start') {
      this.duringTurn?.();
      if (!this.holdTurn) {
        this.frame('item/completed', { item: { id: 'answer', type: 'agentMessage', text: '  Native Codex title  ' } });
        this.frame('turn/completed', { turn: { id: this.turn, status: 'completed', items: [] } });
      }
      return { turn: { id: this.turn } };
    }
    throw new Error('Unexpected fake native method: ' + method);
  }
  frame(method, params = {}, id) { this.listener({ method, params: { threadId: this.id, turnId: this.turn, ...params }, ...(id === undefined ? {} : { id }) }); }
  reject(id, message) { this.rejected.push({ id, message }); }
  respond() { throw new Error('Naming must not answer tool approvals'); }
  destroy() { this.closed = true; }
}

async function codexFixture(t) {
  const cwd = await workspace(t), main = new FakeCodex(), title = new FakeCodex(), events = [];
  const session = new CodexSession({ cwd }, () => {}, main, () => title);
  session.onEvent(event => events.push(event));
  await session.start();
  t.after(() => session.destroy());
  return { session, main, title, events, cwd };
}

test('Codex titles follow native ephemeral empty-environment controls with current model/provider', async t => {
  const { session, main, title, events, cwd } = await codexFixture(t);
  await session.send({ type: 'set_model', provider: 'codex-cli', modelId: 'changed-native-codex' });
  const before = events.length, calls = main.calls.length;
  assert.equal(await session.generateSessionTitle('bounded title prompt', new AbortController().signal), '  Native Codex title  ');
  assert.deepEqual(title.calls.map(call => call.method), ['config/read', 'thread/start', 'turn/start']);
  const start = title.calls[1].params, turn = title.calls[2].params;
  assert.equal(start.model, 'changed-native-codex');
  assert.equal(start.modelProvider, 'native-provider');
  assert.equal(start.cwd, cwd);
  assert.equal(start.ephemeral, true);
  for (const key of ['runtimeWorkspaceRoots', 'environments', 'dynamicTools', 'selectedCapabilityRoots']) assert.deepEqual(start[key], []);
  assert.equal(start.config['features.shell_tool'], false);
  assert.equal(start.config['features.plugins'], false);
  assert.equal(start.config['features.code_mode'], false);
  assert.equal(start.config['tools.update_plan.enabled'], false);
  assert.equal(start.config.web_search, 'disabled');
  assert.deepEqual(start.config.mcp_servers, { 'native.with.dot': { enabled: false }, required: { enabled: false } });
  assert.deepEqual(turn.environments, []);
  assert.equal(turn.threadId, title.id);
  assert.notEqual(turn.threadId, main.id);
  assert.equal(turn.input[0].text, 'bounded title prompt');
  assert.equal(main.calls.length, calls);
  assert.equal(main.closed, false);
  assert.equal(title.closed, true);
  assert.equal(events.length, before);
  assert.deepEqual((await session.send({ type: 'get_messages' })).messages, []);
});

test('Codex fails closed before a model turn when native isolation or selected identity differs', async t => {
  const { session, title, main } = await codexFixture(t);
  title.startResult = { model: 'wrong-model' };
  await assert.rejects(session.generateSessionTitle('title', new AbortController().signal), /changed the native model/);
  assert.equal(title.calls.some(call => call.method === 'turn/start'), false);
  assert.equal(title.closed, true);
  assert.equal(main.closed, false);
});

test('Codex unexpected tool requests abort only the private transport, never main approvals', async t => {
  const { session, title, main } = await codexFixture(t);
  title.duringTurn = () => title.frame('item/commandExecution/requestApproval', {}, 'forbidden-approval');
  await assert.rejects(session.generateSessionTitle('title', new AbortController().signal), /unexpected tool or interaction/);
  assert.equal(title.rejected[0].id, 'forbidden-approval');
  assert.equal(title.closed, true);
  assert.equal(main.closed, false);
});

test('Codex cancellation during configuration cannot send a late model request', async t => {
  const { session, title, main } = await codexFixture(t);
  title.configGate = Promise.withResolvers();
  const controller = new AbortController(), generated = session.generateSessionTitle('title', controller.signal);
  await tick();
  controller.abort(new Error('naming cancelled'));
  await assert.rejects(generated, /naming cancelled/);
  title.configGate.resolve({ config: {} });
  await tick();
  assert.deepEqual(title.calls.map(call => call.method), ['config/read']);
  assert.equal(title.closed, true);
  assert.equal(main.closed, false);
});

test('destroying Codex cancels an active ephemeral naming turn', async t => {
  const { session, title } = await codexFixture(t);
  title.holdTurn = true;
  const generated = session.generateSessionTitle('title', new AbortController().signal);
  await tick();
  session.destroy();
  await assert.rejects(generated, /Codex session closed/);
  assert.equal(title.closed, true);
});

test('Codex title transport pins actual executable/environment and alone enables experimental isolation', async () => {
  const launches = [];
  const spawn = (executable, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const requests = [];
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      const frame = JSON.parse(chunk.toString());
      requests.push(frame);
      if (frame.method === 'initialize') queueMicrotask(() => child.stdout.write(JSON.stringify({ id: frame.id, result: {} }) + '\n'));
      done();
    } });
    launches.push({ executable, args, options, requests, child });
    return child;
  };
  const env = { CODEX_HOME: '/same-native-home', PATH: '/same-native-path' };
  const main = new CodexRpcClient('/same-project', spawn, { executable: '/same-native-codex', env });
  await main.start();
  const title = main.createTitleClient();
  await title.start();
  assert.equal(launches[1].executable, launches[0].executable);
  assert.equal(launches[1].options.env, launches[0].options.env);
  assert.equal(launches[1].options.cwd, launches[0].options.cwd);
  assert.equal(launches[0].requests[0].params.capabilities.experimentalApi, false);
  assert.equal(launches[1].requests[0].params.capabilities.experimentalApi, true);
  title.destroy(); main.destroy();
});
