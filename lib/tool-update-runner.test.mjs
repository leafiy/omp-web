// Exercise the real coordinator with fake child processes only.
// The fake InvocationID also prevents an accidental real systemctl from passing preflight.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { after, mock, test } from 'node:test';
import { createJiti } from 'jiti';

const originalEnv = { ...process.env };
const realRead = fs.readFileSync;
let scenario;
mock.method(fs, 'readFileSync', function(path, ...args) {
  if (path === '/proc/self/cgroup') return '0::/system.slice/omp-web.service\n';
  return realRead.call(this, path, ...args);
});
// A plain replacement avoids retaining execFile's native promisify.custom,
// which would otherwise bypass a function proxy and execute real commands.
const realExecFile = childProcess.execFile;
childProcess.execFile = (file, args, options, callback) => {
  scenario.execs.push({ file, args });
  let stdout;
  if (file === '/usr/bin/systemctl') {
    if (args.includes('show')) stdout = scenario.wrongService ? 'not-this-test' : process.env.INVOCATION_ID;
    else {
      assert.ok(args.includes('restart'));
      assert.deepEqual(args.slice(-2), ['restart', 'omp-web.service']);
      scenario.restarts++; stdout = '';
    }
  } else {
    assert.equal(args[0], '--version');
    assert.ok(file.startsWith(scenario.root), 'refuse non-fixture executable');
    const tool = file.endsWith('/claude') ? 'claude' : file.split('/').at(-1);
    const v = scenario.spawned ? '2.3.5' : '2.3.4';
    stdout = scenario.badVersion && scenario.spawned ? 'invalid-version' : tool === 'omp' ? `omp/${v}` : tool === 'claude' ? `${v} (Claude Code)` : tool === 'codex' ? `codex-cli ${v}` : v;
  }
  queueMicrotask(() => callback(null, { stdout, stderr: '' }));
  return new EventEmitter();
};
mock.method(childProcess, 'spawn', (file, args, options) => {
  assert.ok(file.startsWith(scenario.root), 'refuse real updater');
  assert.equal(options.shell, false);
  assert.equal(options.env.PI_WEB_PASSWORD, undefined);
  assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(options.env.OPENAI_API_KEY, undefined);
  assert.equal(options.env.PI_SESSION_ID, undefined);
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  scenario.spawned = true; scenario.spawns.push({ file, args, env: options.env });
  const finish = () => { child.stdout.write('simulated updater output\n'); child.emit('close', scenario.fail ? 1 : 0, null); };
  scenario.finish = finish;
  if (!scenario.hold) queueMicrotask(finish);
  return child;
});
// Jiti may load built-ins through ESM, whose named exports need synchronization.
syncBuiltinESMExports();
const jiti = createJiti(import.meta.url, { moduleCache: false });
const manager = await jiti.import('./tool-update.ts');
const legacy = await jiti.import('./omp-update.ts');
function setEnvironment(env) {
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
}
after(() => { mock.restoreAll(); childProcess.execFile = realExecFile; syncBuiltinESMExports(); setEnvironment(originalEnv); });

async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'web-update-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  setEnvironment({ ...originalEnv, HOME: root, XDG_STATE_HOME: join(root, 'state'), INVOCATION_ID: 'simulated-invocation-never-production',
    PATH: join(root, 'bin'), OMP_WEB_EXECUTABLE: join(root, 'bin/omp'), OMP_WEB_PI_EXECUTABLE: join(root, 'bin/pi'),
    OMP_WEB_CC_EXECUTABLE: join(root, '.local/bin/claude'), OMP_WEB_CODEX_EXECUTABLE: join(root, 'bin/codex'),
    OMP_CODING_AGENT_DIR: join(root, 'omp'), PI_CODING_AGENT_DIR: join(root, 'omp'), OMP_WEB_PI_AGENT_DIR: join(root, 'pi'),
    OMP_WEB_CC_STATE_DIR: join(root, 'cc'), CLAUDE_CONFIG_DIR: join(root, 'native-claude'), PI_WEB_PASSWORD: 'dummy', OPENAI_API_KEY: 'dummy', ANTHROPIC_API_KEY: 'dummy', PI_SESSION_ID: 'dummy' });
  globalThis.__ompWebToolUpdateStarting = false; globalThis.__ompWebToolUpdateJob = undefined;
  await mkdir(join(root, 'bin'));
  for (const tool of ['npm', 'omp']) await writeFile(join(root, 'bin', tool), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  for (const [tool, name] of [['pi', '@earendil-works/pi-coding-agent'], ['codex', '@openai/codex']]) {
    const pkg = join(root, 'lib/node_modules', name); await mkdir(pkg, { recursive: true });
    const file = join(pkg, `${tool}.js`); await writeFile(file, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name, version: '2.3.4', bin: { [tool]: `${tool}.js` } }));
    await symlink(file, join(root, 'bin', tool));
  }
  const native = join(root, '.local/share/claude/versions/2.3.4'); await mkdir(dirname(native), { recursive: true });
  await writeFile(native, '#!/bin/sh\nexit 99\n', { mode: 0o755 }); await mkdir(join(root, '.local/bin'), { recursive: true });
  await symlink(native, join(root, '.local/bin/claude'));
  scenario = { root, execs: [], spawns: [], restarts: 0, spawned: false, ...options };
}
async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  throw new Error('simulated coordinator timed out');
}
for (const tool of ['pi', 'omp', 'claude', 'codex']) {
  test(`${tool}: successful fake install waits for a new web instance before reporting success`, async (t) => {
    await setup(t);
    assert.equal(manager.getToolUpdates().tools.length, 4);
    assert.equal(scenario.execs.length, 0, 'Coordinator snapshots must not execute CLIs');
    const accepted = await manager.startToolUpdate(tool);
    assert.equal(accepted.job.tool, tool);
    await waitFor(() => !globalThis.__ompWebToolUpdateStarting);
    assert.equal(scenario.spawns.length, 1); assert.equal(scenario.restarts, 1);
    assert.equal(manager.getToolUpdates().job.phase, 'restarting');
    if (tool === 'pi') assert.equal(scenario.spawns[0].env.PI_CODING_AGENT_DIR, join(scenario.root, 'pi'));
    if (tool === 'claude') assert.equal(scenario.spawns[0].env.CLAUDE_CONFIG_DIR, join(scenario.root, 'native-claude'));
    process.env.INVOCATION_ID = 'simulated-new-instance';
    assert.equal(manager.getToolUpdates().job.phase, 'succeeded');
    const state = join(scenario.root, 'state/omp-web/omp-update.json');
    assert.equal(fs.statSync(state).mode & 0o777, 0o600);
  });
}
test('the old OMP endpoint shares the lock with updates of other tools', async (t) => {
  await setup(t, { hold: true });
  await manager.startToolUpdate('pi');
  await waitFor(() => scenario.spawned);
  await assert.rejects(legacy.startOmpUpdate(), error => error.status === 409);
  await assert.rejects(manager.startToolUpdate('codex'), error => error.status === 409);
  scenario.finish(); await waitFor(() => !globalThis.__ompWebToolUpdateStarting);
  assert.equal(scenario.spawns.length, 1);
});
for (const options of [{ fail: true }, { badVersion: true }]) {
  test(`failed update or invalid post-update version does not restart: ${JSON.stringify(options)}`, async (t) => {
    await setup(t, options); await manager.startToolUpdate('omp');
    await waitFor(() => !globalThis.__ompWebToolUpdateStarting);
    assert.equal(manager.getToolUpdates().job.phase, 'failed'); assert.equal(scenario.restarts, 0);
  });
}
test('service identity mismatch cannot launch an updater', async (t) => {
  await setup(t, { wrongService: true });
  await assert.rejects(manager.startToolUpdate('pi'), error => error.status === 503);
  assert.equal(scenario.spawns.length, 0); assert.equal(scenario.restarts, 0);
});
test('an interrupted saved update is reported as failed without a retry', async (t) => {
  await setup(t);
  const state = join(scenario.root, 'state/omp-web/omp-update.json'); await mkdir(dirname(state), { recursive: true });
  await writeFile(state, JSON.stringify({ id: 'interrupted', tool: 'codex', phase: 'updating', invocation: 'old-instance', pid: process.pid, output: '' }));
  assert.equal(manager.getToolUpdates().job.phase, 'failed');
  assert.equal(scenario.execs.length, 0); assert.equal(scenario.spawns.length, 0);
});
