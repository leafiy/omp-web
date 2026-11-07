import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { taskTranscript, codexTaskTranscript } = await jiti.import('./agent-task-messages.ts');
const { AgentTasks } = await jiti.import('./agent-tasks.ts');

test('native and SDK transcripts preserve conversation and tool results, not reasoning or arbitrary metadata', () => {
  const result = taskTranscript([
    { type: 'user', message: { role: 'user', content: 'task input' }, secret: 'metadata' },
    { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'reasoning', text: 'also hidden' }, { type: 'text', text: 'answer' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'tool output' }] } },
  ]);
  assert.deepEqual(result.messages, [{ role: 'user', text: 'task input' }, { role: 'assistant', text: 'answer' }, { role: 'tool', text: 'tool output' }]);
  assert.equal(JSON.stringify(result).includes('hidden'), false);
});

test('child transcript responses are bounded and retain recent messages', () => {
  const result = taskTranscript(Array.from({ length: 300 }, (_, i) => ({ role: 'assistant', content: String(i).padStart(4, '0') + 'x'.repeat(1000) })));
  assert.ok(result.messages.length <= 100);
  assert.ok(result.messages.reduce((n, m) => n + m.text.length, 0) <= 64000);
  assert.equal(result.truncated, true);
  assert.ok(result.messages.at(-1).text.startsWith('0299'));
});

test('Codex child items are projected without copying another thread or reasoning payload', () => {
  const result = codexTaskTranscript({ turns: [{ items: [{ type: 'userMessage', content: [{ type: 'inputText', text: 'input' }] }, { type: 'agentMessage', text: 'answer' }, { type: 'reasoning', text: 'hidden' }, { type: 'commandExecution', command: 'pwd', aggregatedOutput: '/project' }] }] });
  assert.deepEqual(result.messages.map(m => m.role), ['user', 'assistant', 'tool']);
  assert.equal(JSON.stringify(result).includes('hidden'), false);
});

test('Pi conversations are available only for a known task and never enter SSE task metadata', () => {
  const events = [], tasks = new AgentTasks('pi', e => events.push(e));
  assert.throws(() => tasks.detail('foreign'), /Unknown task/);
  tasks.pi({ type: 'tool_execution_start', toolName: 'subagent', toolCallId: 'call' });
  tasks.pi({ type: 'tool_execution_update', toolCallId: 'call', partialResult: { details: { mode: 'single', results: [{ agent: 'worker', exitCode: 0, messages: [{ role: 'assistant', content: [{ type: 'text', text: 'PRIVATE CHILD' }] }] }] } } });
  assert.equal(tasks.detail('call:0').messages[0].text, 'PRIVATE CHILD');
  assert.equal(JSON.stringify(events).includes('PRIVATE CHILD'), false);
  assert.equal(tasks.detail('call').available, false);
});
