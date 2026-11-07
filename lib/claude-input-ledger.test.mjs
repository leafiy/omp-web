import assert from 'node:assert/strict';
import test from 'node:test';
import {createJiti} from 'jiti';
const {ClaudeInputLedger}=await createJiti(import.meta.url).import('./claude-input-ledger.ts');
const message=text=>({role:'user',content:[{type:'text',text}],timestamp:1});

test('batched completion preserves native consumption order, not representative UUID order',()=>{
 const ledger=new ClaudeInputLedger();ledger.add('a',message('initial'),'prompt');ledger.add('b',message('second'),'steer');ledger.add('c',message('third'),'follow_up');
 const ids=ledger.resultIds({user_message_uuid:'c',user_message_uuids:['a','b','c']});assert.deepEqual(ids,['a','b','c']);
 assert.deepEqual(ledger.complete(ids).map(m=>m.content[0].text),['second','third']);assert.equal(ledger.size,0);
});
test('identical messages stay distinct and only unstarted inputs appear in the queue',()=>{
 const ledger=new ClaudeInputLedger();ledger.add('a',message('same'),'steer');ledger.add('b',message('same'),'steer');
 assert.equal(ledger.queued().steering.length,2);assert.equal(ledger.started(['a']).length,1);assert.equal(ledger.started(['a']).length,0);
 ledger.cancel(['a','b'],true);assert.deepEqual(ledger.ids(),['a']);assert.equal(ledger.queued().steering.length,0);
});
test('foreign and uncorrelated replies cannot complete queued input',()=>{
 const ledger=new ClaudeInputLedger();ledger.add('a',message('queued'),'follow_up');assert.deepEqual(ledger.resultIds({}),[]);assert.deepEqual(ledger.resultIds({user_message_uuid:'foreign'}),[]);
 ledger.clear();ledger.add('legacy',message('single'),'prompt');assert.deepEqual(ledger.resultIds({}),['legacy']);
});
