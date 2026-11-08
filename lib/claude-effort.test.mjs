import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';
const jiti=createJiti(import.meta.url);
const {ClaudeCodeSession}=await jiti.import('./claude-code-session.ts');

function fake() {
 let options, wake, closed=false, model='actual-model', effort='medium';
 const applied=[], prompts=[];
 const models=[{value:'alias',resolvedModel:'actual-model',displayName:'Native Model',supportsEffort:true,supportedEffortLevels:['low','medium','high','max']},{value:'small',resolvedModel:'small-model',displayName:'Small',supportsEffort:false}];
 const q={
  async *[Symbol.asyncIterator](){while(!closed)await new Promise(r=>wake=r);},
  initializationResult:async()=>({}),supportedModels:async()=>[{value:'stale'}],supportedCommands:async()=>[],getContextUsage:async()=>({}),
  request:async ({subtype})=>({response:subtype==='list_models'?{models}:{applied:{model,effort},effective:{secret:'must not leak'}}}),
  applyFlagSettings:async s=>{applied.push(s);if(s.effortLevel==='max')effort='high';else effort=s.effortLevel??'medium';},
  setModel:async m=>{model=m==='small'?'small-model':'actual-model';effort=m==='small'?null:'medium';},
  close(){closed=true;wake?.();},
 };
 return {q,applied,prompts,models,get options(){return options;},factory(p){options=p.options;effort=p.options.effort??'medium';void(async()=>{for await(const x of p.prompt)prompts.push(x);})();return q;}};
}
async function fixture(run) {
 const dir=await mkdtemp(join(tmpdir(),'omp-effort-test-'));
 const old={OMP_WEB_CC_STATE_DIR:process.env.OMP_WEB_CC_STATE_DIR,OMP_WEB_CC_EXECUTABLE:process.env.OMP_WEB_CC_EXECUTABLE};
 Object.assign(process.env,{OMP_WEB_CC_STATE_DIR:dir,OMP_WEB_CC_EXECUTABLE:'/fake/claude'});
 try{await run(dir);}finally{for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}await rm(dir,{recursive:true,force:true});}
}

test('catalog reports actual model and effort before any prompt, not stale aliases',()=>fixture(async cwd=>{
 const f=fake(),s=new ClaudeCodeSession({cwd,catalogOnly:true},()=>{},f.factory);
 try{await s.start();const c=await s.send({type:'get_available_models'});assert.deepEqual(c.models,f.models);assert.equal(c.settings.model,'actual-model');assert.equal(c.settings.effort,'medium');assert.equal(c.effortControlAvailable,true);assert.equal(f.prompts.length,0);assert.equal(s.sessionFile,'');}finally{await s.shutdown();}
}));
test('effort settings use native applyFlagSettings, report capped result, and auto actually resets',()=>fixture(async cwd=>{
 const f=fake(),s=new ClaudeCodeSession({cwd},()=>{},f.factory);
 try{
  await s.start();assert.deepEqual(await s.send({type:'get_available_thinking_levels'}),{levels:['low','medium','high','max']});
  const result=await s.send({type:'set_thinking_level',level:'max'});assert.equal(result.thinkingLevel,'high');
  assert.deepEqual(f.applied,[{effortLevel:'max'}]);
  assert.equal((await s.send({type:'get_state'})).thinkingLevel,'high');
  assert.equal((await s.send({type:'set_thinking_level',level:'auto'})).thinkingLevel,'medium');
  assert.deepEqual(f.applied.at(-1),{effortLevel:null});assert.equal(f.prompts.length,0);
  const changed=await s.send({type:'set_model',provider:'claude-code',modelId:'small'});assert.equal(changed.id,'small-model');
  await assert.rejects(s.send({type:'set_thinking_level',level:'high'}),/not supported/i);
 }finally{await s.shutdown();}
}));
test('new-session effort is passed to the CLI and survives web adapter recreation',()=>fixture(async cwd=>{
 const f=fake(),s=new ClaudeCodeSession({cwd,thinkingLevel:'high'},()=>{},f.factory);
 let second;
 try{
  await s.start();assert.equal(f.options.effort,'high');
  await s.send({type:'set_thinking_level',level:'low'});
  const file=s.sessionFile,id=s.sessionId.slice('claude:'.length);await s.shutdown();
  const g=fake();second=new ClaudeCodeSession({cwd,sessionFile:file,nativeId:id},()=>{},g.factory);await second.start();
  assert.equal(g.options.effort,'low');assert.equal((await second.send({type:'get_state'})).thinkingLevel,'low');
 }finally{await s.shutdown();await second?.shutdown();}
}));
test('invalid effort, busy changes and native errors cannot claim success',()=>fixture(async cwd=>{
 const f=fake(),s=new ClaudeCodeSession({cwd},()=>{},f.factory);
 try{await s.start();await assert.rejects(s.send({type:'set_thinking_level',level:'off'}),/effort/i);
  f.q.applyFlagSettings=async()=>{throw Error('native rejected');};
  await assert.rejects(s.send({type:'set_thinking_level',level:'low'}),/native rejected/);
  assert.equal((await s.send({type:'get_state'})).thinkingLevel,'medium');
  await s.send({type:'prompt',message:'synthetic mock only'});
  await assert.rejects(s.send({type:'set_thinking_level',level:'low'}),/finish|busy/i);
 }finally{await s.shutdown();}
}));
