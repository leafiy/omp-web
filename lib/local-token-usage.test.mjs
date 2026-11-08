import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
const jiti=createJiti(import.meta.url,{alias:{'@':fileURLToPath(new URL('..',import.meta.url))}});
const {createLocalTokenTracker,parseUsageLine}=await jiti.import('./local-token-usage.ts');

// Fake native stores in a temporary directory only: no real ~/.claude, OMP or Pi data is read.
const NOW=Date.now(),HOUR=3600_000,DAY=24*HOUR;
const ccLine=(id,req,at,usage)=>JSON.stringify({type:'assistant',timestamp:new Date(at).toISOString(),requestId:req,uuid:`${id}-${at}`,message:{id,role:'assistant',content:[{type:'text',text:'x'}],usage}})+'\n';
const ompLine=(id,at,usage)=>JSON.stringify({type:'message',id,parentId:null,timestamp:new Date(at).toISOString(),message:{role:'assistant',content:[],timestamp:at,usage:{...usage,totalTokens:0}}})+'\n';
async function setup(t){
 const root=await mkdtemp(join(tmpdir(),'local-tokens-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const roots={claude:join(root,'claude','projects'),omp:join(root,'omp','sessions'),pi:join(root,'pi-not-installed','sessions')};
 await mkdir(join(roots.claude,'-proj','s1','subagents'),{recursive:true});await mkdir(join(roots.omp,'-cwd'),{recursive:true});
 const statePath=join(root,'state','local-tokens.json');
 const make=()=>createLocalTokenTracker({roots:()=>roots,statePath,now:()=>NOW,interval:false});
 return {root,roots,statePath,make};
}
const row=(tracker,engine,starts=[NOW-DAY])=>tracker.periods(starts).find(r=>r.engine===engine);

test('Claude records count once across content-block lines, forked copies and subagent files',async t=>{
 const {roots,make}=await setup(t);
 const usage={input_tokens:10,output_tokens:20,cache_read_input_tokens:30,cache_creation_input_tokens:40};
 const recent=NOW-HOUR,lastWeek=NOW-8*DAY;
 await writeFile(join(roots.claude,'-proj','s1.jsonl'),
  ccLine('msg_1','req_1',recent,usage)+ccLine('msg_1','req_1',recent+500,usage)+ccLine('msg_2','req_2',lastWeek,usage)
  +JSON.stringify({type:'user',message:{role:'user',content:'mentions "usage" and "assistant" in text'}})+'\n');
 await writeFile(join(roots.claude,'-proj','fork.jsonl'),ccLine('msg_1','req_1',recent,usage));
 await writeFile(join(roots.claude,'-proj','s1','subagents','agent-a.jsonl'),ccLine('msg_3','req_3',recent,{input_tokens:1,output_tokens:2}));
 const tracker=make();await tracker.refresh();
 const claude=row(tracker,'claude',[NOW-6*HOUR,NOW-30*DAY]);
 assert.equal(claude.complete,true);
 assert.deepEqual(claude.periods[0],[11,22,30,40]);
 assert.deepEqual(claude.periods[1],[21,42,60,80]);
 assert.deepEqual(tracker.periods([NOW]).map(r=>r.engine),['claude','omp'],'an engine without a store on this machine is omitted');
});

test('a line still being written is read whole later; persisted offsets resume without double counts',async t=>{
 const {roots,statePath,make}=await setup(t);
 const file=join(roots.omp,'-cwd','a.jsonl'),first=ompLine('entry-alpha',NOW-HOUR,{input:5,output:6,cacheRead:7,cacheWrite:8}),second=ompLine('entry-beta',NOW-HOUR+1,{input:1,output:1,cacheRead:0,cacheWrite:0});
 await writeFile(file,first+second.slice(0,30));
 let tracker=make();await tracker.refresh();
 assert.deepEqual(row(tracker,'omp').periods[0],[5,6,7,8]);
 await appendFile(file,second.slice(30));await tracker.refresh();
 assert.deepEqual(row(tracker,'omp').periods[0],[6,7,7,8]);
 const saved=await readFile(statePath,'utf8');
 assert.ok(!saved.includes('entry-alpha')&&!saved.includes('assistant'),'the summary stores hashed keys and totals, not transcript content');
 tracker=make();
 assert.deepEqual(row(tracker,'omp').periods[0],[6,7,7,8],'a restarted service answers from the persisted summary before scanning');
 await writeFile(join(roots.omp,'-cwd','branch.jsonl'),first+second);await tracker.refresh();
 assert.deepEqual(row(tracker,'omp').periods[0],[6,7,7,8],'a branch copying entries keeps their native IDs and is not counted again');
});

test('rewritten files are reread without double counts; deleting a transcript keeps usage that happened',async t=>{
 const {roots,make}=await setup(t);
 const file=join(roots.omp,'-cwd','a.jsonl'),first=ompLine('e1',NOW-HOUR,{input:5,output:0,cacheRead:0,cacheWrite:0}),second=ompLine('e2',NOW-HOUR,{input:3,output:0,cacheRead:0,cacheWrite:0});
 await writeFile(file,first+second);
 const tracker=make();await tracker.refresh();
 assert.deepEqual(row(tracker,'omp').periods[0],[8,0,0,0]);
 await writeFile(file,second);await tracker.refresh();
 assert.deepEqual(row(tracker,'omp').periods[0],[8,0,0,0]);
 await rm(file);await tracker.refresh();
 assert.deepEqual(row(tracker,'omp').periods[0],[8,0,0,0]);
});

test('only the retention window is counted, and period starts select by local instant',async t=>{
 const {roots,make}=await setup(t);
 await writeFile(join(roots.omp,'-cwd','a.jsonl'),ompLine('old',NOW-45*DAY,{input:100,output:0,cacheRead:0,cacheWrite:0})+ompLine('week',NOW-3*DAY,{input:2,output:0,cacheRead:0,cacheWrite:0})+ompLine('today',NOW-HOUR,{input:1,output:0,cacheRead:0,cacheWrite:0}));
 const stale=join(roots.omp,'-cwd','stale.jsonl');
 await writeFile(stale,ompLine('stale',NOW-50*DAY,{input:1000,output:0,cacheRead:0,cacheWrite:0}));await utimes(stale,new Date(NOW-50*DAY),new Date(NOW-50*DAY));
 const tracker=make();await tracker.refresh();
 const omp=row(tracker,'omp',[NOW-2*HOUR,NOW-7*DAY,NOW-39*DAY]);
 assert.deepEqual(omp.periods.map(p=>p[0]),[1,3,3]);
});

test('parser accepts native assistant usage records only',()=>{
 assert.equal(parseUsageLine('claude','not json'),null);
 assert.equal(parseUsageLine('claude',JSON.stringify({type:'user',timestamp:new Date(NOW).toISOString(),message:{usage:{input_tokens:1}}})),null);
 assert.equal(parseUsageLine('omp',JSON.stringify({type:'message',id:'u',message:{role:'user',timestamp:NOW,usage:{input:1}}})),null);
 assert.deepEqual(parseUsageLine('pi',ompLine('p1',NOW,{input:1,output:2,cacheRead:3,cacheWrite:4}).trim()),{key:`p1:${NOW}`,at:NOW,parts:[1,2,3,4]});
 assert.deepEqual(parseUsageLine('claude',ccLine('m','r',NOW,{input_tokens:-1,output_tokens:2.5,cache_read_input_tokens:3}).trim()).parts,[0,0,3,0]);
});
