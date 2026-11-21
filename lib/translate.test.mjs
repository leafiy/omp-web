import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const {
  chatCompletionsUrl, chunkProse, completionErrorDetail, completionText, planTranslation, splitCodeFences, translationPrompt,
  translationRequestBody, assembleTranslation,
} = await jiti.import('./translate-text.ts');
const { translateTexts, TranslateError } = await jiti.import('./translate-service.ts');
const { splitPastedTokens } = await jiti.import('./pasted-text.ts');
const { createSendTranslationStore } = await jiti.import('./translate-client.ts');
const { createMessageTranslationStore, translationSourceKey, MESSAGE_TRANSLATIONS_STORAGE_KEY } = await jiti.import('./message-translations.ts');

test('uses the Index-Translate template with the source language named', () => {
  assert.equal(translationPrompt('zh2en', '你好'), '请将以下中文文本翻译为英语，直接输出翻译结果，不要进行任何解释。\n\n你好');
  assert.equal(translationPrompt('en2zh', 'Hello'), '请将以下英语文本翻译为中文，直接输出翻译结果，不要进行任何解释。\n\nHello');
});

test('uses the Hunyuan-MT template and server sampling for hy-mt models', () => {
  assert.deepEqual(translationRequestBody('zh2en', '你好', 'hy-mt2-1.8b'), {
    model: 'hy-mt2-1.8b',
    messages: [{ role: 'user', content: '将以下文本翻译为英语，注意只需要输出翻译后的结果，不要额外解释：\n\n你好' }],
    stream: false,
  });
  assert.equal(translationRequestBody('en2zh', 'Hi', 'hy-mt2-1.8b').messages[0].content, '将以下文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：\n\nHi');
  assert.deepEqual(translationRequestBody('en2zh', 'Hi', 'index-translate:2b'), {
    model: 'index-translate:2b',
    messages: [{ role: 'user', content: translationPrompt('en2zh', 'Hi') }],
    temperature: 0,
    stream: false,
  });
});

test('resolves the chat-completions URL from an origin, an OpenAI base or a full URL', () => {
  assert.equal(chatCompletionsUrl('http://gateway:9940'), 'http://gateway:9940/v1/chat/completions');
  assert.equal(chatCompletionsUrl(' http://gateway:9940/v1/ '), 'http://gateway:9940/v1/chat/completions');
  assert.equal(chatCompletionsUrl('https://api.example/openai/chat/completions'), 'https://api.example/openai/chat/completions');
  assert.equal(chatCompletionsUrl('ftp://gateway/v1'), null);
  assert.equal(chatCompletionsUrl('http://user:pass@gateway/v1'), null);
  assert.equal(chatCompletionsUrl('gateway:9940'), null);
  assert.equal(chatCompletionsUrl('http://gateway:9940/services/hy-mt2/v1'), 'http://gateway:9940/services/hy-mt2/v1/chat/completions');
});

test('keeps fenced code verbatim and round-trips the text', () => {
  const text = 'Intro line\n```ts\nconst a = "中文";\n```\nOutro\n~~~\nunclosed\n';
  const segments = splitCodeFences(text);
  assert.equal(segments.map((segment) => segment.text).join(''), text);
  assert.deepEqual(segments.map((segment) => segment.translate), [true, false, true, false]);
  assert.equal(segments[1].text, '```ts\nconst a = "中文";\n```\n');
  // Inline triple backticks with more backticks after them are not a fence.
  assert.deepEqual(splitCodeFences('```a` b\nmore').map((segment) => segment.translate), [true]);
});

test('chunks long prose at paragraph, line and sentence boundaries', () => {
  const paragraph = `${'这是一个句子。'.repeat(40)}`; // 280 chars
  const text = `${paragraph}\n\n${paragraph}\n\n${'word '.repeat(200)}`;
  const chunks = chunkProse(text, 300);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 300));
  assert.ok(chunks[0].endsWith('\n\n'));
  const hard = 'x'.repeat(650);
  assert.deepEqual(chunkProse(hard, 300).map((chunk) => chunk.length), [300, 300, 50]);
});

test('plans only lettered prose for translation and keeps surrounding whitespace', () => {
  assert.deepEqual(planTranslation('\n  你好世界  \n\n---\n\n```\ncode\n```\n'), [
    { translate: true, lead: '\n  ', core: '你好世界  \n\n---', trail: '\n\n' },
    { translate: false, text: '```\ncode\n```\n' },
  ]);
  assert.deepEqual(planTranslation('---\n\n```\nx\n```\n  \n'), [
    { translate: false, text: '---\n\n' },
    { translate: false, text: '```\nx\n```\n' },
    { translate: false, text: '  \n' },
  ]);
});

test('keeps pasted attachments verbatim and translates only surrounding prose', () => {
  const attachment = `<pasted-text>\n${'附件原文，不要翻译。\n'.repeat(200)}\n\`\`\`ts\nconst x = 1;\n</pasted-text>`;
  const second = '<pasted-text>\nAnother attachment\n</pasted-text>';
  const pieces = planTranslation(`请阅读\n${attachment}\n然后总结\n${second}`, 100);
  assert.deepEqual(pieces.filter((piece) => piece.translate).map((piece) => piece.core), ['请阅读', '然后总结']);
  assert.equal(assembleTranslation(pieces, ['Please read', 'Then summarize']), `Please read\n${attachment}\nThen summarize\n${second}`);
  assert.deepEqual(planTranslation(attachment), [{ translate: false, text: attachment }]);
});

test('reads completion text and error details', () => {
  assert.equal(completionText({ choices: [{ message: { content: '<think>x</think>\n Hello ' } }] }), 'Hello');
  assert.equal(completionText({ choices: [{ message: { content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] } }] }), 'AB');
  assert.equal(completionText({ choices: [] }), null);
  assert.equal(completionErrorDetail({ error: { code: 'busy', message: 'no backend' } }, ''), 'no backend');
  assert.equal(completionErrorDetail({ detail: 'Not Found' }, ''), 'Not Found');
  assert.equal(completionErrorDetail({ detail: { error: { code: 'no_backend', message: 'No backend for llm_general' } } }, '{}'), 'No backend for llm_general');
  assert.equal(completionErrorDetail(null, ' bad gateway '), 'bad gateway');
});

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    return handler(body);
  };
  return { calls, fetchImpl };
}

const reply = (content) => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), { status: 200 });
const config = { endpoint: 'http://gateway:9940/v1', model: 'index-translate:2b', apiKey: '' };

test('translates prose through the configured API and leaves code untouched', async () => {
  const { calls, fetchImpl } = fakeFetch((body) => reply(`EN(${body.messages[0].content.split('\n\n').slice(1).join('\n\n')})`));
  const [out, second] = await translateTexts(['你好\n\n```sh\necho 中文\n```\n再见', '谢谢'], 'zh2en', config, new AbortController().signal, fetchImpl);
  assert.equal(out, 'EN(你好)\n\n```sh\necho 中文\n```\nEN(再见)');
  assert.equal(second, 'EN(谢谢)');
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.url, 'http://gateway:9940/v1/chat/completions');
    assert.equal(call.body.model, 'index-translate:2b');
    assert.equal(call.body.temperature, 0);
    assert.equal(call.body.messages.length, 1);
    assert.equal(call.body.messages[0].role, 'user');
    assert.equal(call.headers.Authorization, undefined);
  }
});

test('sends the API key as a bearer token and reports API errors', async () => {
  const { calls, fetchImpl } = fakeFetch(() => new Response(JSON.stringify({ error: { message: 'no healthy backend' } }), { status: 503 }));
  await assert.rejects(
    translateTexts(['Hello'], 'en2zh', { ...config, apiKey: 'sk-test' }, new AbortController().signal, fetchImpl),
    (error) => error instanceof TranslateError && error.status === 502 && /HTTP 503: no healthy backend/.test(error.message),
  );
  assert.equal(calls[0].headers.Authorization, 'Bearer sk-test');
});

test('splits composer text around paste markers', () => {
  assert.deepEqual(splitPastedTokens('see [paste #1 +12 lines] and [paste #2 1500 chars]'), [
    { token: false, text: 'see ' },
    { token: true, text: '[paste #1 +12 lines]' },
    { token: false, text: ' and ' },
    { token: true, text: '[paste #2 1500 chars]' },
  ]);
  assert.deepEqual(splitPastedTokens('plain'), [{ token: false, text: 'plain' }]);
});

const memoryStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key), data };
};

test('the translate-before-send toggle applies only to its own conversation', () => {
  const disk = memoryStorage({ 'omp-web:translate-before-send': 'zh2en' });
  const store = createSendTranslationStore(() => disk);
  // The old browser-wide choice no longer turns every chat on.
  assert.equal(store.readSendTranslation('session-a'), null);
  assert.equal(disk.data.has('omp-web:translate-before-send'), false);

  store.writeSendTranslation('session-a', 'zh2en');
  assert.equal(store.readSendTranslation('session-a'), 'zh2en');
  assert.equal(store.readSendTranslation('pi:session-b'), null);
  assert.equal(store.readSendTranslation('new:omp:/project'), null);
  assert.equal(store.readSendTranslation(undefined), null);

  // Another tab sees it, and its own write does not clobber this one.
  const otherTab = createSendTranslationStore(() => disk);
  assert.equal(otherTab.readSendTranslation('session-a'), 'zh2en');
  otherTab.writeSendTranslation('pi:session-b', 'en2zh');
  assert.equal(store.readSendTranslation('session-a'), 'zh2en');
  assert.equal(store.readSendTranslation('pi:session-b'), 'en2zh');

  store.writeSendTranslation('session-a', null);
  assert.equal(createSendTranslationStore(() => disk).readSendTranslation('session-a'), null);
  assert.equal(createSendTranslationStore(() => disk).readSendTranslation('pi:session-b'), 'en2zh');
});

test('a new chat keeps its toggle when it becomes a session and leaves the next new chat off', () => {
  const disk = memoryStorage(), store = createSendTranslationStore(() => disk);
  store.writeSendTranslation('new:omp:/a', 'en2zh');
  store.moveSendTranslation('new:omp:/a', 'new:omp:/b');
  assert.equal(store.readSendTranslation('new:omp:/a'), null);
  assert.equal(store.readSendTranslation('new:omp:/b'), 'en2zh');
  store.moveSendTranslation('new:omp:/b', 'session-c');
  assert.equal(store.readSendTranslation('session-c'), 'en2zh');
  assert.equal(store.readSendTranslation('new:omp:/b'), null);
  // Moving an off chat clears what an abandoned chat left at the target.
  store.writeSendTranslation('new:omp:/b', 'zh2en');
  store.moveSendTranslation('new:omp:/a', 'new:omp:/b');
  assert.equal(store.readSendTranslation('new:omp:/b'), null);
});

test('toggle storage is bounded and survives blocked or corrupt storage', () => {
  const disk = memoryStorage(), store = createSendTranslationStore(() => disk);
  for (let i = 0; i < 205; i++) store.writeSendTranslation(`session-${i}`, 'zh2en');
  assert.equal(store.readSendTranslation('session-0'), null);
  assert.equal(store.readSendTranslation('session-204'), 'zh2en');
  assert.equal(JSON.parse(disk.data.get('omp-web:translate-before-send:v2')).entries.length, 200);

  const blocked = createSendTranslationStore(() => ({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } }));
  blocked.writeSendTranslation('session', 'en2zh');
  assert.equal(blocked.readSendTranslation('session'), 'en2zh');
  assert.equal(blocked.readSendTranslation('other'), null);

  const corrupt = createSendTranslationStore(() => memoryStorage({ 'omp-web:translate-before-send:v2': '{not json' }));
  assert.equal(corrupt.readSendTranslation('session'), null);
});

test('message translations stay with their conversation across views and reloads', () => {
  const disk = memoryStorage(), store = createMessageTranslationStore(() => disk);
  const key = translationSourceKey('你好');
  assert.equal(key, translationSourceKey('你好'));
  assert.notEqual(key, translationSourceKey('你好！'));

  store.writeMessageTranslation('session:a', key, { direction: 'zh2en', status: 'loading' }, true);
  assert.equal(disk.data.has(MESSAGE_TRANSLATIONS_STORAGE_KEY), false);
  const done = { direction: 'zh2en', status: 'done', text: 'Hello' };
  store.writeMessageTranslation('session:a', key, done, true);
  // The same object comes back, so an unchanged message does not re-render.
  assert.equal(store.readMessageTranslation('session:a', key), done);
  assert.equal(store.readMessageTranslation('session:b', key), null);

  // A reload (or switching back) shows it again; another conversation does not.
  const reloaded = createMessageTranslationStore(() => disk);
  assert.deepEqual(reloaded.readMessageTranslation('session:a', key), done);
  assert.equal(reloaded.readMessageTranslation('session:b', key), null);

  // Errors and results outside a conversation stay with the page.
  store.writeMessageTranslation('session:a', translationSourceKey('x'), { direction: 'en2zh', status: 'error', error: 'HTTP 502' }, true);
  store.writeMessageTranslation('view:1', key, { direction: 'zh2en', status: 'done', text: 'Hi' }, false);
  assert.deepEqual(JSON.parse(disk.data.get(MESSAGE_TRANSLATIONS_STORAGE_KEY)).entries, [['session:a', key, 'zh2en', 'Hello']]);

  // Closing forgets it everywhere.
  store.writeMessageTranslation('session:a', key, null, true);
  assert.equal(store.readMessageTranslation('session:a', key), null);
  assert.equal(disk.data.has(MESSAGE_TRANSLATIONS_STORAGE_KEY), false);
  assert.equal(createMessageTranslationStore(() => disk).readMessageTranslation('session:a', key), null);
});

test('message translations follow other tabs and keep this page\'s pending work', () => {
  const disk = memoryStorage(), tab = createMessageTranslationStore(() => disk), other = createMessageTranslationStore(() => disk);
  const a = translationSourceKey('a'), b = translationSourceKey('b');
  tab.writeMessageTranslation('session:s', a, { direction: 'en2zh', status: 'done', text: '甲' }, true);
  tab.writeMessageTranslation('session:s', b, { direction: 'en2zh', status: 'loading' }, true);
  let notified = 0;
  tab.subscribeMessageTranslations(() => { notified++; });

  other.writeMessageTranslation('session:s', a, null, true);
  other.writeMessageTranslation('session:t', a, { direction: 'en2zh', status: 'done', text: '乙' }, true);
  tab.refresh();
  assert.equal(notified, 1);
  assert.equal(tab.readMessageTranslation('session:s', a), null);
  assert.equal(tab.readMessageTranslation('session:t', a).text, '乙');
  assert.equal(tab.readMessageTranslation('session:s', b).status, 'loading');
});

test('saved message translations are bounded and survive blocked or full storage', () => {
  const disk = memoryStorage(), store = createMessageTranslationStore(() => disk);
  for (let i = 0; i < 305; i++) store.writeMessageTranslation('session:s', translationSourceKey(`m${i}`), { direction: 'en2zh', status: 'done', text: `t${i}` }, true);
  const saved = JSON.parse(disk.data.get(MESSAGE_TRANSLATIONS_STORAGE_KEY)).entries;
  assert.equal(saved.length, 300);
  assert.equal(saved[0][3], 't5');
  assert.equal(saved.at(-1)[3], 't304');
  // Evicted results still show on this page.
  assert.equal(store.readMessageTranslation('session:s', translationSourceKey('m0')).text, 't0');

  const huge = createMessageTranslationStore(() => disk);
  huge.writeMessageTranslation('session:s', translationSourceKey('long'), { direction: 'zh2en', status: 'done', text: 'x'.repeat(1_000_001) }, true);
  assert.equal(huge.readMessageTranslation('session:s', translationSourceKey('long')).text.length, 1_000_001);
  assert.equal(JSON.parse(disk.data.get(MESSAGE_TRANSLATIONS_STORAGE_KEY)).entries.some(([, key]) => key === translationSourceKey('long')), false);

  let writes = 0;
  const full = { ...memoryStorage(), setItem() { writes++; throw new Error('QuotaExceededError'); } };
  const quota = createMessageTranslationStore(() => full);
  for (let i = 0; i < 4; i++) quota.writeMessageTranslation('session:s', translationSourceKey(`q${i}`), { direction: 'en2zh', status: 'done', text: `q${i}` }, true);
  assert.equal(quota.readMessageTranslation('session:s', translationSourceKey('q3')).text, 'q3');
  assert.ok(writes > 0);

  const blocked = createMessageTranslationStore(() => ({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } }));
  blocked.writeMessageTranslation('session:s', translationSourceKey('z'), { direction: 'zh2en', status: 'done', text: 'Z' }, true);
  assert.equal(blocked.readMessageTranslation('session:s', translationSourceKey('z')).text, 'Z');

  const corrupt = createMessageTranslationStore(() => memoryStorage({ [MESSAGE_TRANSLATIONS_STORAGE_KEY]: '{not json' }));
  assert.equal(corrupt.readMessageTranslation('session:s', translationSourceKey('z')), null);
});
