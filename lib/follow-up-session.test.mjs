import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const { FollowUpSession } = await createJiti(import.meta.url).import('./follow-up-session.ts');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { for (let i=0;i<100;i++) { if (predicate()) return; await delay(10); } throw Error('Condition not reached'); }
class Native {
  constructor(engine) { this.engine=engine;this.sessionId=engine+':owned';this.sessionFile='/fake/session';this.cwd='/fake'; }
  alive=true;busy=true;listeners=new Set();calls=[];prompts=[];
  start=async()=>{};
  isAlive=()=>this.alive;
  isRunning=()=>this.busy;
  getActiveLeafId=()=>undefined;
  waitUntilReady=async()=>{if(!this.alive)throw Error('closed')};
  onDestroy=fn=>{this.destroyed=fn};
  onEvent=fn=>{this.listeners.add(fn);fn({type:'task_snapshot',snapshot:{tasks:[]}});return()=>this.listeners.delete(fn)};
  emit=e=>{for(const fn of this.listeners)fn(e)};
  state=()=>({sessionId:this.sessionId,isStreaming:this.busy,isPromptRunning:this.busy,isSettled:!this.busy,queuedMessages:{steering:[],followUp:[]},queuedItems:[]});
  send=async command=>{
    this.calls.push(command);
    if(command.type==='get_state')return this.readState?this.readState():this.state();
    if(command.type==='prompt'){
      if(this.busy)throw Error('busy');
      this.prompts.push(command.message);this.busy=true;this.emit({type:'agent_start'});
      if(this.rejectPrompt){this.busy=false;throw Error('connection lost after possible acceptance')}
      if(this.holdPrompt)return new Promise(resolve=>{this.release=resolve});
      return null;
    }
    if(command.type==='abort'){this.busy=false;this.emit({type:'agent_settled'});return null}
    if(command.type==='recall_queued_message')return {removed:true,text:'native steering'};
    if(command.type==='clear_queue')return {steering:['native steering'],followUp:[]};
    return null;
  };
  finish=()=>{this.busy=false;this.emit({type:'prompt_done'});this.emit({type:'agent_settled'})};
  destroy=()=>{this.alive=false;this.destroyed?.()};
  shutdown=async()=>this.destroy();
}
for(const engine of ['omp','pi','claude','codex'])test(`${engine}: follow-ups have owned IDs, survive SSE detach and are individually recoverable before delivery`,async t=>{
  const native=new Native(engine),session=new FollowUpSession(native,()=>{});t.after(()=>session.destroy());
  const a=await session.send({type:'follow_up',message:'first'}),b=await session.send({type:'follow_up',message:'second'});
  assert.notEqual(a.id,b.id);assert.equal(native.prompts.length,0);
  const replay=[];session.onEvent(e=>replay.push(e))();
  assert.deepEqual(replay.find(e=>e.type==='queue_update').items.map(i=>i.id),[a.id,b.id]);
  assert.equal(session.isRunning(),true);
  assert.deepEqual(await session.send({type:'recall_queued_message',id:a.id,recover:true}),{removed:true,text:'first',kind:'follow_up'});
  assert.equal((await session.send({type:'recall_queued_message',id:a.id})).removed,false);
  native.finish();await until(()=>native.prompts.length===1);
  assert.deepEqual(native.prompts,['second']);
  assert.equal((await session.send({type:'get_state'})).webFollowUpPending,0);
  assert.ok(!native.calls.some(c=>c.type==='follow_up'||c.type==='clear_queue'),'never clear/requeue native inputs to emulate per-item recall');
});

test('FIFO continues with no browser listener and never dispatches two inputs at once',async t=>{
  const n=new Native('pi'),s=new FollowUpSession(n,()=>{});t.after(()=>s.destroy());
  await s.send({type:'follow_up',message:'one'});await s.send({type:'follow_up',message:'two'});
  n.finish();await until(()=>n.prompts.length===1);await delay(80);assert.deepEqual(n.prompts,['one']);
  n.finish();await until(()=>n.prompts.length===2);assert.deepEqual(n.prompts,['one','two']);
});

test('recall wins while the idle-state query is still in flight',async t=>{
  const n=new Native('codex'),s=new FollowUpSession(n,()=>{});t.after(()=>s.destroy());
  n.busy=false;let resolve;n.readState=()=>new Promise(r=>{resolve=r});
  const item=await s.send({type:'follow_up',message:'do not send'});await until(()=>!!resolve);
  assert.equal((await s.send({type:'recall_queued_message',id:item.id})).removed,true);
  resolve(n.state());await delay(80);assert.deepEqual(n.prompts,[]);
});

test('sending and already-consumed messages cannot claim withdrawal',async t=>{
  const n=new Native('omp'),s=new FollowUpSession(n,()=>{});t.after(()=>s.destroy());
  n.holdPrompt=true;
  const item=await s.send({type:'follow_up',message:'claimed'});n.finish();await until(()=>!!n.release);
  assert.equal((await s.send({type:'get_state'})).queuedItems[0].state,'sending');
  assert.equal((await s.send({type:'recall_queued_message',id:item.id})).removed,false);
  await assert.rejects(s.send({type:'prompt',message:'race'}),/handed/);
  n.release(null);await delay(20);assert.equal((await s.send({type:'recall_queued_message',id:item.id})).removed,false);
});

test('uncertain delivery pauses automatic work, never retries, and recovery is explicitly a copy',async t=>{
  const n=new Native('claude'),s=new FollowUpSession(n,()=>{});t.after(()=>s.destroy());
  n.rejectPrompt=true;
  const item=await s.send({type:'follow_up',message:'uncertain'});await s.send({type:'follow_up',message:'later'});n.finish();
  await until(()=>n.prompts.length===1);await delay(80);
  assert.equal((await s.send({type:'get_state'})).queuedItems[0].state,'unconfirmed');
  assert.equal((await s.send({type:'recall_queued_message',id:item.id})).removed,false);
  const recovered=await s.send({type:'recall_queued_message',id:item.id,recover:true});
  assert.equal(recovered.uncertain,true);assert.equal(recovered.removed,false);assert.equal(recovered.text,'uncertain');
  n.finish();await delay(80);assert.deepEqual(n.prompts,['uncertain']);
  n.rejectPrompt=false;await s.send({type:'prompt',message:'explicit retry'});n.finish();await until(()=>n.prompts.length===3);
  assert.deepEqual(n.prompts,['uncertain','explicit retry','later']);
});

test('a failed native turn pauses remaining follow-ups instead of draining them into repeated errors',async t=>{
  const n=new Native('codex'),s=new FollowUpSession(n,()=>{});t.after(()=>s.destroy());
  await s.send({type:'follow_up',message:'later'});
  n.emit({type:'prompt_error',errorMessage:'quota unavailable'});n.finish();await delay(80);
  assert.deepEqual(n.prompts,[]);assert.equal((await s.send({type:'get_state'})).queuedMessages.followUpPaused,true);
  await s.send({type:'prompt',message:'manual continuation'});n.finish();await until(()=>n.prompts.length===2);
  assert.deepEqual(n.prompts,['manual continuation','later']);
});

test('Stop prevents queued delivery; native steering retains its own recall path',async t=>{
  const n=new Native('claude'),s=new FollowUpSession(n,()=>{});t.after(()=>s.destroy());
  await s.send({type:'follow_up',message:'cancel me'});await s.send({type:'abort'});await delay(80);
  assert.deepEqual(n.prompts,[]);assert.equal((await s.send({type:'get_state'})).webFollowUpPending,0);
  assert.equal((await s.send({type:'recall_queued_message',id:'native-id'})).text,'native steering');
});

test('mixed native steering and host follow-ups remain visible; bulk recovery does not drop newer inputs',async t=>{
  const n=new Native('omp'),s=new FollowUpSession(n,()=>{});t.after(()=>s.destroy());
  n.emit({type:'queue_update',steering:['native steering'],followUp:[]});
  await s.send({type:'follow_up',message:'web later'});
  const replay=[];s.onEvent(e=>replay.push(e))();
  assert.deepEqual(replay.find(e=>e.type==='queue_update').steering,['native steering']);
  const original=n.send;let release;
  n.send=async command=>command.type==='clear_queue'?new Promise(resolve=>{release=resolve}):original(command);
  const clearing=s.send({type:'clear_queue'});await until(()=>!!release);
  await s.send({type:'follow_up',message:'new arrival'});
  release({steering:['native steering'],followUp:[]});
  const removed=await clearing;
  assert.deepEqual(removed,{steering:['native steering'],followUp:['web later']});
  assert.deepEqual((await s.send({type:'get_state'})).queuedMessages.followUp,['new arrival']);
});

test('a manual prompt wins over an older idle snapshot without causing an uncertain queued handoff',async t=>{
  const n=new Native('pi'),s=new FollowUpSession(n,()=>{});t.after(()=>s.destroy());
  n.busy=false;const idle=n.state();let release;n.readState=()=>new Promise(resolve=>{release=resolve});
  await s.send({type:'follow_up',message:'queued'});await until(()=>!!release);n.readState=undefined;
  await s.send({type:'prompt',message:'manual'});release(idle);await delay(80);
  assert.deepEqual(n.prompts,['manual']);assert.equal((await s.send({type:'get_state'})).queuedItems[0].state,'queued');
  n.finish();await until(()=>n.prompts.length===2);assert.deepEqual(n.prompts,['manual','queued']);
});

test('concurrent enqueue respects the queue bound and IDs cannot cancel another owner',async t=>{
  const n=new Native('codex'),s=new FollowUpSession(n,()=>{}),other=new FollowUpSession(new Native('codex'),()=>{});t.after(()=>{s.destroy();other.destroy()});
  const results=await Promise.allSettled(Array.from({length:33},(_,i)=>s.send({type:'follow_up',message:String(i)})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,32);
  assert.equal(results.filter(r=>r.status==='rejected').length,1);
  const id=results.find(r=>r.status==='fulfilled').value.id;
  assert.equal((await other.send({type:'recall_queued_message',id})).removed,false);
  assert.equal((await s.send({type:'get_state'})).webFollowUpPending,32);
});

test('invalid/oversized input and session changes are rejected; malformed state cannot authorize sending',async t=>{
  const n=new Native('pi'),s=new FollowUpSession(n,()=>{});t.after(()=>s.destroy());
  for(const command of [{message:''},{message:'/new'},{message:'x',images:[{}]},{message:'x'.repeat(65537)}])await assert.rejects(s.send({type:'follow_up',...command}));
  n.busy=false;n.readState=async()=>({sessionId:'foreign',isStreaming:false});
  await s.send({type:'follow_up',message:'safe'});await delay(80);assert.deepEqual(n.prompts,[]);
  await assert.rejects(s.send({type:'fork'}),/Withdraw/);
});
