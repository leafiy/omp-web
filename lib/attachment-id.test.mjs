import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const { createAttachmentId } = await createJiti(import.meta.url).import('./attachment-id.ts');

function withCrypto(value, run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value });
  try { run(); } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
    else delete globalThis.crypto;
  }
}

test('uses native randomUUID when available, retaining its receiver', () => {
  const crypto = { randomUUID() { assert.equal(this, crypto); return 'native-id'; } };
  withCrypto(crypto, () => assert.equal(createAttachmentId(), 'native-id'));
});

test('HTTP-like crypto without randomUUID uses getRandomValues', () => {
  const crypto = { getRandomValues(bytes) { assert.equal(this, crypto); bytes.fill(171); return bytes; } };
  withCrypto(crypto, () => assert.equal(createAttachmentId(), 'ab'.repeat(16)));
});

test('missing crypto APIs do not break attachments and same-tick IDs differ', () => {
  for (const crypto of [undefined, {}]) withCrypto(crypto, () => {
    const ids = Array.from({ length: 100 }, () => createAttachmentId());
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^[a-zA-Z0-9-]+$/);
  });
});
