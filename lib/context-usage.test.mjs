import assert from 'node:assert/strict';
import test from 'node:test';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);
const {resolveContextUsage,claudeContextUsage}=await jiti.import('./context-usage.ts');
const {ClaudeContextCache}=await jiti.import('./claude-context-cache.ts');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const summary=(window=1000000)=>({maxTokens:window,rawMaxTokens:2000000,totalTokens:12000,percentage:1});

test('unknown capacity is not replaced by an invented 128K window or token percentage',()=>{
 assert.equal(resolveContextUsage(null),undefined);
 assert.equal(resolveContextUsage({contextWindow:0,tokens:123,percent:4}),undefined);
 assert.deepEqual(resolveContextUsage(null,1000000),{contextWindow:1000000,tokens:null,percent:null});
 for(const value of [NaN,Infinity,-1,0,1.5])assert.equal(resolveContextUsage(null,value),undefined);
});
test('native capacity and percentage win even when smaller than a catalog entry',()=>{
 for(const contextWindow of [128000,200000,1000000]){
  const native={contextWindow,tokens:12000,percent:1};assert.deepEqual(resolveContextUsage(native,2000000),native);
 }
 assert.deepEqual(claudeContextUsage(summary()),{contextWindow:1000000,tokens:12000,percent:1});
 assert.deepEqual(claudeContextUsage({maxTokens:200000}),{contextWindow:200000,tokens:null,percent:null});
 assert.deepEqual(claudeContextUsage({maxTokens:200000,totalTokens:0,percentage:0}),{contextWindow:200000,tokens:0,percent:0});
 assert.equal(claudeContextUsage({rawMaxTokens:1000000}),null);
 assert.equal(claudeContextUsage({maxTokens:NaN}),null);
});
test('context cache coalesces calls, caches successful reads and never reads while blocked',async()=>{
 let calls=0,time=0;const cache=new ClaudeContextCache(async()=>{calls++;return summary()},{now:()=>time});
 const [a,b]=await Promise.all([cache.get(),cache.get()]);assert.deepEqual(a,b);assert.equal(calls,1);
 await cache.get();assert.equal(calls,1);assert.equal(await cache.get(true),null);assert.equal(calls,1);
 time=10001;await cache.get();assert.equal(calls,2);
});
test('late summaries cannot survive model/turn invalidation',async()=>{
 let finish,calls=0;const cache=new ClaudeContextCache(()=>{calls++;return calls===1?new Promise(resolve=>{finish=resolve}):Promise.resolve(summary(200000))});
 const old=cache.get();await tick();cache.invalidate();finish(summary());assert.equal(await old,null);
 const current=await cache.get();assert.equal(current.contextWindow,200000);assert.equal(calls,2);
});
test('failed or unsupported summary metadata is unknown without failing chat or leaking diagnostics',async()=>{
 let calls=0;const cache=new ClaudeContextCache(async()=>{calls++;throw Error('private-native-error')});
 assert.equal(await cache.get(),null);assert.equal(await cache.get(),null);assert.equal(calls,1);
 cache.invalidate();assert.equal(await cache.get(),null);assert.equal(calls,2);
});
test('a timed-out read stays single-flight and can never restore invalidated data',async()=>{
 let finish,calls=0;const cache=new ClaudeContextCache(()=>{calls++;return new Promise(resolve=>{finish=resolve})},{timeoutMs:5});
 assert.equal(await cache.get(),null);assert.equal(await cache.get(),null);assert.equal(calls,1);
 cache.invalidate();finish(summary());await tick();assert.equal(await cache.get(true),null);
});
