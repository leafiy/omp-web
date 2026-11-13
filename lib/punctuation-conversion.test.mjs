import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { convertPunctuation, convertPromptPunctuation, readPunctuationConversion } = await jiti.import('./punctuation-conversion.ts');
const { expandPastedTokens, pastedTextToken, splitPastedBlocks } = await jiti.import('./pasted-text.ts');

test('covers every fullwidth ASCII character and ideographic space', () => {
  for (let code = 0xff01; code <= 0xff5e; code++) {
    assert.equal(convertPunctuation(String.fromCharCode(code)), String.fromCharCode(code - 0xfee0));
  }
  assert.equal(convertPunctuation('ＡＢＣ１２３　，。！？：；'), 'ABC123 ,.!?:;');
});

test('Chinese brackets, quotes, dashes, ellipses and halfwidth punctuation', () => {
  assert.equal(convertPunctuation('「你好」『世界』“双”‘单’'), '"你好""世界""双"\'单\'');
  assert.equal(convertPunctuation('〈〉《》【】〔〕〖〗〘〙〚〛｟｠'), '<><>[][][][][]()');
  assert.equal(convertPunctuation('、｡､｢｣･…‥⋯—–〜〰'), ',.,""' + '.'.repeat(9) + '--~~');
  assert.equal(convertPunctuation('‼⁇⁈⁉'), '!!???!!?');
});

test('vertical and small punctuation, width variants of currency', () => {
  assert.equal(convertPunctuation('︐︑︒︓︔︕︖︗︘︙'), ',,.:;!?[]...');
  assert.equal(convertPunctuation('︵︶︷︸︹︺︻︼︽︾︿﹀﹁﹂﹃﹄'), '(){}[][]<><>""""');
  assert.equal(convertPunctuation('﹐﹑﹒﹔﹕﹖﹗﹙﹚﹛﹜﹝﹞﹟﹠﹡﹢﹣﹤﹥﹦﹨﹩﹪﹫'), ',,.;:!?(){}[]#&*+-<>=\\$%@');
  assert.equal(convertPunctuation('﹉﹊﹋﹌﹍﹎﹏'), '----___');
  assert.equal(convertPunctuation('￠￡￥￦'), '¢£¥₩');
});

test('preserves unrelated Unicode, ASCII and line endings; conversion is idempotent', () => {
  const unchanged = '汉字かな한글 café 😀 ∑∞≠ ① ㎏ ²\n\tASCII {} [] ! /\r\n';
  assert.equal(convertPunctuation(unchanged), unchanged);
  const once = convertPunctuation('你好，世界！「Ａ」︙￥');
  assert.equal(convertPunctuation(once), once);
});

test('default enabled, disabled is verbatim, commands cannot be created or rewritten', () => {
  assert.equal(readPunctuationConversion(), true);
  assert.equal(convertPromptPunctuation('你好，世界。', false), '你好，世界。');
  assert.equal(convertPromptPunctuation('你好，世界。', true), '你好,世界.');
  for (const command of ['!echo “你好”', '!!echo ，', '/skill 参数，']) {
    assert.equal(convertPromptPunctuation(command, true), command);
  }
  assert.equal(convertPromptPunctuation('　！echo “你好”', true), ' ！echo "你好"');
  assert.equal(convertPromptPunctuation('／skill 参数，', true), '／skill 参数,');
});

test('conversion after expansion includes pasted contents without breaking wrappers', () => {
  const paste = { id: 1, text: '代码：“你好”；\n'.repeat(12) };
  const expanded = expandPastedTokens(`请看：${pastedTextToken(paste)}`, [paste]);
  const converted = convertPromptPunctuation(expanded, true);
  assert.deepEqual(splitPastedBlocks(converted), [
    { type: 'text', text: '请看:' },
    { type: 'paste', text: '代码:"你好";\n'.repeat(12) },
  ]);
});
