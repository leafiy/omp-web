import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const {
  chatCompletionsUrl, chunkProse, completionErrorDetail, completionText, planTranslation, splitCodeFences, translationPrompt,
  translationRequestBody,
} = await jiti.import('./translate-text.ts');
const { translateTexts, TranslateError } = await jiti.import('./translate-service.ts');
const { splitPastedTokens } = await jiti.import('./pasted-text.ts');
const { createSendTranslationStore } = await jiti.import('./translate-client.ts');

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
