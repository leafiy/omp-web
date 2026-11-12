import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const {
  shouldCollapsePaste, pastedTextToken, expandPastedTokens, collapsePastedBlocks, livePastedTexts,
  splitPastedBlocks, summarizePastedBlocks, unwrapPastedBlocks, repairPastedTokenEdit, snapCaretOutOfToken,
} = await createJiti(import.meta.url).import('./pasted-text.ts');

const long = { id: 1, text: `${'line\n'.repeat(11)}end` };
const TOKEN = '[paste #1 +12 lines]';

test('only long pastes that can round-trip become markers', () => {
  assert.equal(shouldCollapsePaste(`${'a\n'.repeat(9)}a`), false);
  assert.equal(shouldCollapsePaste('a\n'.repeat(10)), true);
  assert.equal(shouldCollapsePaste('x'.repeat(1000)), false);
  assert.equal(shouldCollapsePaste('x'.repeat(1001)), true);
  assert.equal(shouldCollapsePaste(' \n'.repeat(40)), false);
  assert.equal(shouldCollapsePaste(`${'x'.repeat(2000)}</pasted-text>`), false);
  assert.equal(pastedTextToken(long), TOKEN);
  assert.equal(pastedTextToken({ id: 2, text: 'x'.repeat(1500) }), '[paste #2 1500 chars]');
});

test('markers expand into wrapped blocks and fold back for editing', () => {
  const sent = expandPastedTokens(`see ${TOKEN} please`, [long]);
  assert.equal(sent, `see <pasted-text>\n${long.text}\n</pasted-text> please`);
  assert.deepEqual(collapsePastedBlocks(sent), { value: `see ${TOKEN} please`, pastedTexts: [long] });
  // New markers never reuse the ID of one already in the draft.
  assert.equal(collapsePastedBlocks(sent, [{ id: 4, text: 'kept' }]).value, 'see [paste #5 +12 lines] please');
});

test('command drafts expand verbatim and unknown markers stay literal', () => {
  assert.equal(expandPastedTokens(`!wc -l <<'EOF'\n${TOKEN}`, [long]), `!wc -l <<'EOF'\n${long.text}`);
  assert.equal(expandPastedTokens(`/review ${TOKEN}`, [long]), `/review ${long.text}`);
  // A pasted line starting with "!" or "/" can never turn the message into a command.
  const shellLike = { id: 3, text: `!rm -rf x\n${long.text}` };
  assert.match(expandPastedTokens(pastedTextToken(shellLike), [shellLike]), /^<pasted-text>\n!rm/);
  assert.equal(expandPastedTokens('[paste #9 +99 lines]', [long]), '[paste #9 +99 lines]');
  assert.deepEqual(livePastedTexts('typed only', [long]), []);
});

test('transcript text splits into attachments and one-line summaries', () => {
  const message = 'a\n<pasted-text>\nBODY\n</pasted-text>\nb';
  assert.deepEqual(splitPastedBlocks(message), [
    { type: 'text', text: 'a\n' }, { type: 'paste', text: 'BODY' }, { type: 'text', text: '\nb' },
  ]);
  assert.deepEqual(splitPastedBlocks('plain'), [{ type: 'text', text: 'plain' }]);
  assert.equal(summarizePastedBlocks(message), 'a\n[paste #1 4 chars]\nb');
  assert.equal(unwrapPastedBlocks(message), 'a\nBODY\nb');
  // Previews arrive whitespace-collapsed or cut off.
  assert.equal(summarizePastedBlocks('<pasted-text> BODY </pasted-text> tail'), '[paste #1 4 chars] tail');
  assert.equal(summarizePastedBlocks('ask <pasted-text>\nfoo bar'), 'ask [paste #1]');
});

test('an edit that damages a marker removes all of it', () => {
  assert.deepEqual(repairPastedTokenEdit(`a${TOKEN}`, `a${TOKEN.slice(0, -1)}`, [long], 20), { value: 'a', caret: 1 });
  assert.deepEqual(repairPastedTokenEdit(TOKEN, `${TOKEN.slice(0, 5)}x${TOKEN.slice(5)}`, [long], 6), { value: 'x', caret: 1 });
  // The same character typed right in front of a marker is not an edit inside it.
  assert.equal(repairPastedTokenEdit(TOKEN, `[${TOKEN}`, [long], 1), null);
  assert.equal(repairPastedTokenEdit(`[${TOKEN}`, TOKEN, [long], 0), null);
  assert.equal(repairPastedTokenEdit(`${TOKEN} hi`, `${TOKEN} hi!`, [long], 24), null);
  assert.equal(repairPastedTokenEdit(`a${TOKEN}`, 'a', [long]), null);
});

test('the caret steps over a marker', () => {
  const value = `ab${TOKEN}`;
  assert.equal(snapCaretOutOfToken(value, 21, 22, [long]), 2);
  assert.equal(snapCaretOutOfToken(value, 3, 2, [long]), 22);
  assert.equal(snapCaretOutOfToken(value, 5, null, [long]), 2);
  assert.equal(snapCaretOutOfToken(value, 1, null, [long]), 1);
});
