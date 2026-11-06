// All installers and HTTP services are fake. Never run a real update or restart.
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { planToolUpdate, validToolVersion } = await jiti.import('./tool-update-plan.ts');
const { parseToolUpdateRequest, TOOL_IDS } = await jiti.import('./tool-update-types.ts');
const { createToolUpdateHandlers } = await jiti.import('./tool-update-http.ts');
const { ToolUpdateError } = await jiti.import('./tool-update.ts');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'web-tool-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'npm'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  return { root, bin };
}
async function globalPackage(prefix, name, tool) {
  const pkg = join(prefix, 'lib', 'node_modules', name);
  await mkdir(join(pkg, 'bin'), { recursive: true });
  const executable = join(pkg, 'bin', `${tool}.js`);
  await writeFile(executable, '#!/usr/bin/env node\nthrow new Error("Do not execute test fixture");\n', { mode: 0o755 });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name, version: '1.2.3', bin: { [tool]: `bin/${tool}.js` } }));
  await mkdir(join(prefix, 'bin'), { recursive: true });
  const launcher = join(prefix, 'bin', tool); await symlink(executable, launcher);
  return { launcher, pkg, executable };
}

test('only four fixed targets with explicit confirmation are accepted', () => {
  for (const tool of TOOL_IDS) assert.equal(parseToolUpdateRequest({ tool, confirm: true }), tool);
  for (const body of [null, [], {}, { tool: 'pi' }, { tool: 'pi', confirm: false }, { tool: 'pi', confirm: 'true' },
    { tool: 'shell', confirm: true }, { tool: 'pi; touch /tmp/pwned', confirm: true },
    { tool: 'pi', confirm: true, command: 'sh' }, { tool: 'omp', confirm: true, executable: '/tmp/omp' }]) {
    assert.throws(() => parseToolUpdateRequest(body));
  }
});

for (const [tool, name] of [['pi', '@earendil-works/pi-coding-agent'], ['codex', '@openai/codex']]) {
  test(`${tool} updates the selected global prefix through symlink chains, not the npm default`, async (t) => {
    const { root, bin } = await fixture(t);
    const prefix = join(root, 'selected-prefix');
    const installed = await globalPackage(prefix, name, tool);
    const alias = join(bin, tool); await symlink(installed.launcher, alias);
    const plan = planToolUpdate(tool, alias, root, bin);
    assert.equal(plan.executable, alias);
    assert.equal(plan.command, join(bin, 'npm'));
    assert.deepEqual(plan.args, ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--include=optional', '--no-audit', '--no-fund', name + '@latest']);
    assert.equal(plan.installedVersion, '1.2.3');
  });
}

test('a project-local Pi dependency or unrelated wrapper cannot trigger global replacement', async (t) => {
  const { root, bin } = await fixture(t);
  const script = join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'bin', 'pi.js');
  await mkdir(dirname(script), { recursive: true });
  await writeFile(script, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const alias = join(bin, 'pi'); await symlink(script, alias);
  assert.throws(() => planToolUpdate('pi', alias, root, bin), /official global npm/);
});

test('a selected package must match the global bin, not just a similar directory name', async (t) => {
  const { root, bin } = await fixture(t);
  const installed = await globalPackage(join(root, 'prefix'), '@openai/codex', 'codex');
  await writeFile(join(installed.pkg, 'package.json'), JSON.stringify({ name: 'untrusted', bin: { codex: 'bin/codex.js' } }));
  assert.throws(() => planToolUpdate('codex', installed.launcher, root, bin), /official global npm/);
});

test('Claude uses only the managed native launcher, not a pinned alternate binary', async (t) => {
  const { root, bin } = await fixture(t);
  const native = join(root, '.local/share/claude/versions/2.1.318');
  await mkdir(dirname(native), { recursive: true });
  await writeFile(native, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const launcher = join(root, '.local/bin/claude');
  await mkdir(dirname(launcher), { recursive: true }); await symlink(native, launcher);
  assert.deepEqual(planToolUpdate('claude', launcher, root, bin), {
    tool: 'claude', executable: launcher, command: launcher, args: ['update'], installedVersion: '2.1.318',
  });
  const pinned = join(bin, 'claude'); await symlink(native, pinned);
  assert.throws(() => planToolUpdate('claude', pinned, root, bin), /native/);
});

test('OMP updates the configured native executable without channel overrides', async (t) => {
  const { root, bin } = await fixture(t);
  const executable = join(bin, 'omp'); await writeFile(executable, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  assert.deepEqual(planToolUpdate('omp', executable, root, bin), { tool: 'omp', executable, command: executable, args: ['update'] });
  await chmod(executable, 0o600);
  assert.throws(() => planToolUpdate('omp', executable, root, bin), /not found/);
});

test('versions must belong to the selected tool before a restart is allowed', () => {
  for (const [tool, version] of [['pi', '1.5.0'], ['omp', 'omp/18.16.0'], ['claude', '2.1.318 (Claude Code)'], ['codex', 'codex-cli 0.155.1']]) {
    assert.equal(validToolVersion(tool, version), true);
    assert.equal(validToolVersion(tool, 'success'), false);
    assert.equal(validToolVersion(tool, version + '\nerror'), false);
  }
  assert.equal(validToolVersion('pi', 'omp/18.16.0'), false);
});

function request(body, overrides = {}) {
  return new Request('http://localhost/api/tools/update', {
    method: 'POST', headers: { Host: 'localhost', Origin: 'http://localhost', 'Content-Type': 'application/json', ...overrides },
    body: JSON.stringify(body),
  });
}
function withPassword(t, value) {
  const old = process.env.PI_WEB_PASSWORD;
  if (value === undefined) delete process.env.PI_WEB_PASSWORD; else process.env.PI_WEB_PASSWORD = value;
  t.after(() => { if (old === undefined) delete process.env.PI_WEB_PASSWORD; else process.env.PI_WEB_PASSWORD = old; });
}
function fakeService() {
  const calls = [];
  const snapshot = { tools: TOOL_IDS.map(tool => ({ tool, available: true, phase: 'idle', output: '' })), job: null };
  const handlers = createToolUpdateHandlers({ getStatus: () => snapshot, start: async (tool) => { calls.push(tool); return snapshot; } });
  return { calls, handlers };
}

test('GET is inspection only; rejected POSTs never reach the updater', async (t) => {
  withPassword(t, undefined);
  const { calls, handlers } = fakeService();
  const result = await handlers.GET(new Request('http://localhost/api/tools/update', { headers: { Host: 'localhost' } }));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.equal((await handlers.POST(request({ tool: 'pi', confirm: false }))).status, 400);
  assert.equal((await handlers.POST(request({ tool: 'pi', confirm: true }, { 'Content-Type': 'text/plain' }))).status, 415);
  assert.equal((await handlers.POST(request({ tool: 'pi', confirm: true }, { Origin: 'https://evil.invalid' }))).status, 403);
  assert.equal((await handlers.POST(request({ tool: 'pi', confirm: true }, { Host: 'evil.invalid', Origin: 'http://evil.invalid' }))).status, 403);
  assert.deepEqual(calls, []);
});

test('password validation protects GET and POST even without middleware', async (t) => {
  withPassword(t, 'test-only-password');
  const { calls, handlers } = fakeService();
  assert.equal((await handlers.GET(new Request('http://localhost/api/tools/update', { headers: { Host: 'localhost' } }))).status, 401);
  assert.equal((await handlers.POST(request({ tool: 'claude', confirm: true }))).status, 401);
  assert.deepEqual(calls, []);
  const auth = 'Basic ' + Buffer.from('pi:test-only-password').toString('base64');
  assert.equal((await handlers.POST(request({ tool: 'claude', confirm: true }, { Authorization: auth }))).status, 202);
  assert.deepEqual(calls, ['claude']);
});

test('each confirmed target dispatches only to that target', async (t) => {
  withPassword(t, undefined);
  const { calls, handlers } = fakeService();
  for (const tool of TOOL_IDS) assert.equal((await handlers.POST(request({ tool, confirm: true }))).status, 202);
  assert.deepEqual(calls, TOOL_IDS);
});

test('busy or unavailable updates return a failure, never fake success', async (t) => {
  withPassword(t, undefined);
  const handlers = createToolUpdateHandlers({ getStatus: () => { throw new Error('unused'); }, start: async () => { throw new ToolUpdateError('busy', 409); } });
  assert.equal((await handlers.POST(request({ tool: 'codex', confirm: true }))).status, 409);
});
