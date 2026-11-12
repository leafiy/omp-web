import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const { createDraftStore } = await createJiti(import.meta.url).import('./draft-store.ts');
const storage = () => {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key), data };
};

test('draft text survives a fresh store, but images and transient notices do not persist', () => {
  const disk = storage(), first = createDraftStore(() => disk);
  first.setDraft('new:claude:/project', { value: '未发送\n草稿', images: [{ data: 'private-image', mimeType: 'image/png' }], notice: 'temporary' });
  const reloaded = createDraftStore(() => disk);
  assert.deepEqual(reloaded.getDraft('new:claude:/project'), { value: '未发送\n草稿', images: [] });
  assert.equal(JSON.stringify([...disk.data.values()]).includes('private-image'), false);
});

test('drafts remain isolated by engine, directory and session', () => {
  const disk = storage(), store = createDraftStore(() => disk);
  for (const key of ['new:pi:/a', 'new:omp:/a', 'new:pi:/b', 'pi:session']) store.setDraft(key, { value: key, images: [] });
  const reload = createDraftStore(() => disk);
  for (const key of ['new:pi:/a', 'new:omp:/a', 'new:pi:/b', 'pi:session']) assert.equal(reload.getDraft(key).value, key);
});

test('accepted send clears only its unchanged draft, not a newer edit', () => {
  const disk = storage(), store = createDraftStore(() => disk);
  const sent = { value: 'first', images: [] };
  store.setDraft('session', sent);
  store.setDraft('session', { value: 'newer', images: [] });
  store.clearDraftIfUnchanged('session', sent);
  assert.equal(createDraftStore(() => disk).getDraft('session').value, 'newer');
  store.clearDraftIfUnchanged('session', { value: 'newer', images: [] });
  assert.equal(createDraftStore(() => disk).getDraft('session'), null);
});

test('explicit empty text removes the persisted draft and blocked storage stays usable', () => {
  const disk = storage(), store = createDraftStore(() => disk);
  store.setDraft('session', { value: 'text', images: [] });
  store.setDraft('session', { value: '', images: [] });
  assert.equal(createDraftStore(() => disk).getDraft('session'), null);
  const blocked = createDraftStore(() => { throw Error('storage blocked'); });
  blocked.setDraft('s', { value: 'still editable', images: [] });
  assert.equal(blocked.getDraft('s').value, 'still editable');
  blocked.clearDraft('s'); assert.equal(blocked.getDraft('s'), null);
});

test('malformed persistent data never breaks the composer', () => {
  const broken = createDraftStore(() => ({ getItem: () => '{invalid', setItem() {}, removeItem() {} }));
  assert.equal(broken.getDraft('s'), null);
});

test('pasted text behind a marker survives reload; an unpersisted marker is dropped, not left as literal text', async () => {
  const { pastedTextToken } = await createJiti(import.meta.url).import('./pasted-text.ts');
  const disk = storage(), store = createDraftStore(() => disk);
  const pasted = { id: 1, text: 'line\n'.repeat(12) };
  const value = `see ${pastedTextToken(pasted)}`;
  store.setDraft('s', { value, images: [], pastedTexts: [pasted] });
  assert.deepEqual(createDraftStore(() => disk).getDraft('s'), { value, images: [], pastedTexts: [pasted] });
  store.clearDraftIfUnchanged('s', { value, images: [], pastedTexts: [{ id: 1, text: 'other' }] });
  assert.equal(store.getDraft('s').value, value);
  const huge = { id: 2, text: 'x'.repeat(500_001) };
  store.setDraft('s', { value: `keep ${pastedTextToken(huge)}`, images: [], pastedTexts: [huge] });
  assert.equal(store.getDraft('s').pastedTexts[0].text.length, 500_001);
  assert.deepEqual(createDraftStore(() => disk).getDraft('s'), { value: 'keep ', images: [] });
});
