import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { readClaudeModels, readClaudeModelSettings, claudeModelsData, claudeEffortLevels } = await jiti.import('./claude-models.ts');
const rows = [
 { value: 'default', resolvedModel: 'native-opus', displayName: 'Native default', supportsEffort: true, supportedEffortLevels: ['low','high','max'] },
 { value: 'sonnet', resolvedModel: 'native-sonnet', displayName: 'Sonnet', supportsEffort: true, supportedEffortLevels: ['low','medium','high'] },
 { value: 'haiku', resolvedModel: 'native-haiku', displayName: 'Haiku', supportsEffort: false },
];

test('live catalog supersedes stale SDK initialization models', async () => {
 const q = { request: async r => { assert.equal(r.subtype, 'list_models'); return { response: { models: rows } }; }, supportedModels: async () => { throw Error('stale catalog must not be read'); } };
 assert.deepEqual(await readClaudeModels(q), rows);
});
test('old native CLIs can use the SDK catalog; real query errors are not hidden', async () => {
 assert.deepEqual(await readClaudeModels({ supportedModels: async()=>rows }), rows);
 assert.deepEqual(await readClaudeModels({ request: async()=>{throw Error('Unknown control request subtype: list_models');}, supportedModels: async()=>rows }), rows);
 await assert.rejects(readClaudeModels({ request: async()=>{throw Error('connection closed');}, supportedModels: async()=>rows }), /connection closed/);
});
test('settings projection returns only applied model and effort, never raw settings or credentials', async () => {
 const q = { request: async r => { assert.equal(r.subtype,'get_settings'); return { response: { effective: { env: { API_KEY: 'never-return' } }, sources: ['private-path'], applied: { model: 'native-sonnet', effort: 'medium' } } }; } };
 assert.deepEqual(await readClaudeModelSettings(q), { model: 'native-sonnet', effort: 'medium' });
});
test('catalog preserves native IDs and per-model effort, and reports the actual configured default', () => {
 const data=claudeModelsData(rows,{model:'native-sonnet',effort:'medium'},true);
 assert.deepEqual(data.defaultModel,{provider:'claude-code',modelId:'native-sonnet'});
 assert.equal(data.modelList.find(m=>m.id==='sonnet').resolvedModel,'native-sonnet');
 assert.deepEqual(data.thinkingLevels['claude-code:native-sonnet'],['low','medium','high']);
 assert.deepEqual(data.thinkingLevels['claude-code:sonnet'],['low','medium','high']);
 assert.deepEqual(data.thinkingLevels['claude-code:native-haiku'],[]);
 assert.equal(data.defaultThinkingLevel,'medium');
 assert.equal(data.effortControlAvailable,true);
 assert.deepEqual(claudeEffortLevels(rows,'native-opus'),['low','high','max']);
});
test('a configured custom model is visible without invented capabilities', () => {
 const data=claudeModelsData(rows,{model:'custom-model',effort:null},true);
 assert.ok(data.modelList.some(m=>m.id==='custom-model'));
 assert.equal(data.defaultModel.modelId,'custom-model');
 assert.deepEqual(claudeEffortLevels(rows,'custom-model'),[]);
});
test('empty or singleton effort lists are authoritative, never generic thinking levels', () => {
 assert.deepEqual(claudeEffortLevels([{value:'only-high',supportsEffort:true,supportedEffortLevels:['high']}],'only-high'),['high']);
 assert.deepEqual(claudeEffortLevels([{value:'unknown',supportsEffort:true}],'unknown'),[]);
 assert.equal(claudeModelsData(rows,undefined,false).effortControlAvailable,false);
});
