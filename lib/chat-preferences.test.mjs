import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const { preferredEngine, preferredModel, rememberChatChoice } = await createJiti(import.meta.url).import('./chat-preferences.ts');

function withStorage(run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  } });
  try { run(values); } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
  }
}

test('remembers the project engine and isolates model choices by project and engine', () => withStorage(() => {
  const pi = { provider: 'openai', modelId: 'pi-model' };
  const omp = { provider: 'anthropic', modelId: 'omp-model' };
  rememberChatChoice('/a', 'pi', pi);
  rememberChatChoice('/a', 'omp', omp);
  rememberChatChoice('/b', 'claude', { provider: 'anthropic', modelId: 'other' });
  assert.equal(preferredEngine('/a'), 'omp');
  assert.equal(preferredEngine('/b'), 'claude');
  assert.deepEqual(preferredModel('/a', 'pi'), pi);
  assert.deepEqual(preferredModel('/a', 'omp'), omp);
  assert.equal(preferredModel('/b', 'pi'), null);
  rememberChatChoice('/a', 'pi');
  assert.equal(preferredEngine('/a'), 'pi');
  assert.deepEqual(preferredModel('/a', 'omp'), omp);
}));

test('missing, malformed and unrecognized preferences are ignored', () => withStorage(values => {
  assert.equal(preferredEngine('/missing'), undefined);
  assert.equal(preferredModel('/missing', 'pi'), null);
  for (const value of ['{bad', 'null', '[]', '"text"', '{"engine":"unknown","models":{"pi":{"provider":42,"modelId":"x"}}}']) {
    values.set('omp-web:chat-preferences:/a', value);
    assert.equal(preferredEngine('/a'), undefined);
    assert.equal(preferredModel('/a', 'pi'), null);
  }
}));

test('storage denial never prevents selecting an engine or model', () => withStorage(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('denied'); } });
  assert.doesNotThrow(() => rememberChatChoice('/a', 'pi', { provider: 'p', modelId: 'm' }));
  assert.equal(preferredEngine('/a'), undefined);
  assert.equal(preferredModel('/a', 'pi'), null);
}));
