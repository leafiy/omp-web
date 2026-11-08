// Fake Codex app-server only. No CLI, credentials or models are used.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { CodexSession } = await jiti.import('./codex-session.ts');
const { CodexRpcClient, listCodexModels } = await jiti.import('./codex-rpc-client.ts');
const { engineForSession, sessionKey, nativeSessionId, parseEngine } = await jiti.import('./engine.ts');
const { codexChildEnvironment, getCodexWebDir } = await jiti.import('./codex-config.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));

class FakeCodex {
  calls = []; replies = []; errors = []; closed = false; startCount = 0;
  id = randomUUID(); turn = randomUUID(); model = 'test-codex';
  onFrame(fn) { this.listener = fn; }
  onClose(fn) { this.closeListener = fn; }
  async start() { this.startCount++; }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/start' || method === 'thread/resume') return {
      thread: { id: this.id, status: { type: 'idle' }, turns: [] }, cwd: params.cwd, model: params.model || this.model,
      approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite' }, ...this.startResult,
    };
    if (method === 'thread/read') {
      if (this.readError) throw new Error(this.readError);
      return { thread: { id: params.threadId, turns: [] } };
    }
    if (method === 'turn/start') {
      if (this.early) this.early();
      if (this.holdStart) return new Promise(resolve => { this.releaseStart = () => resolve({ turn: { id: this.turn } }); });
      return { turn: { id: this.turn } };
    }
    if (method === 'turn/interrupt') return {};
    if (method === 'model/list') return { data: [{ model: 'test-codex' }, { model: 'other-codex' }], nextCursor: null };
    throw new Error('Unexpected native method '+method);
  }
  respond(id, result) { this.replies.push({ id, result }); }
  reject(id, message) { this.errors.push({ id, message }); }
  destroy() { this.closed = true; }
  frame(method, params, id) { this.listener({ method, params: { threadId: this.id, turnId: this.turn, ...params }, ...(id === undefined ? {} : { id }) }); }
  complete(status = 'completed') { this.frame('turn/completed', { turn: { id: this.turn, status, items: [] } }); }
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'codex-web-test-'));
  const old = process.env.OMP_WEB_CODEX_STATE_DIR;
  process.env.OMP_WEB_CODEX_STATE_DIR = join(root, 'web');
  const cwd = join(root, 'project'); await mkdir(cwd);
  const fake = new FakeCodex(), events = [];
  const session = new CodexSession({ cwd }, () => {}, fake);
  session.onEvent(event => events.push(event));
  t.after(async () => {
    session.destroy();
    if (old === undefined) delete process.env.OMP_WEB_CODEX_STATE_DIR; else process.env.OMP_WEB_CODEX_STATE_DIR = old;
    await rm(root, { recursive: true, force: true });
  });
  await session.start();
  return { root, cwd, fake, session, events };
}
test('known child activity outlives the parent without admitting child messages or foreign threads', async t => {
  const { session, fake, events } = await fixture(t);
  await session.send({ type: 'prompt', message: 'delegate' });
  fake.frame('item/completed', { item: { id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['child'], agentsStates: { child: { status: 'pendingInit' } } } });
  fake.complete();
  assert.equal((await session.send({ type: 'get_state' })).isPromptRunning, false);
  assert.equal(session.isRunning(), true);
  fake.frame('item/completed', { threadId: 'child', item: { id: 'private', type: 'agentMessage', text: 'CHILD PRIVATE' } });
  fake.frame('thread/status/changed', { threadId: 'foreign', status: { type: 'active' } });
  assert.equal(finalTexts(events).includes('CHILD PRIVATE'), false);
  assert.equal((await session.send({ type: 'get_state' })).tasks.tasks.length, 1);
  fake.frame('thread/status/changed', { threadId: 'child', status: { type: 'idle' } });
  assert.equal(session.isRunning(), false);
});

test('Codex child detail is an owned read-only thread query, not a main history append', async t => {
  const { session, fake, events } = await fixture(t);
  const before = fake.calls.length;
  await assert.rejects(session.send({ type: 'get_task_detail', taskId: 'foreign' }), /Unknown task/);
  assert.equal(fake.calls.length, before);
  await session.send({ type: 'prompt', message: 'delegate' });
  fake.frame('item/completed', { item: { id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', receiverThreadIds: ['child'] } });
  const original = fake.request.bind(fake);
  fake.request = async (method, params) => method === 'thread/read' && params.threadId === 'child'
    ? { thread: { id: 'child', turns: [{ items: [{ type: 'agentMessage', text: 'CHILD DETAIL' }] }] } }
    : original(method, params);
  const detail = await session.send({ type: 'get_task_detail', taskId: 'child' });
  assert.equal(detail.messages[0].text, 'CHILD DETAIL');
  assert.equal(finalTexts(events).includes('CHILD DETAIL'), false);
});

function finalTexts(events) { return events.filter(e => e.type === 'message_end' && e.message?.role === 'assistant').flatMap(e => e.message.content).filter(b => b.type === 'text').map(b => b.text); }

test('Codex has its own stable session namespace', () => {
  const id=randomUUID(); assert.equal(parseEngine('codex'),'codex');
  assert.equal(engineForSession(sessionKey('codex',id)),'codex'); assert.equal(nativeSessionId('codex:'+id),id);
  assert.notEqual(sessionKey('codex',id),sessionKey('claude',id));
});
test('initialization creates no model turn; resume uses only the exact native ID', async t => {
  const { session, fake, cwd }=await fixture(t);
  assert.deepEqual(fake.calls.map(c=>c.method),['thread/start','thread/read']);
  assert.equal(fake.calls[1].params.includeTurns,true);
  assert.equal(session.sessionId,'codex:'+fake.id);
  const file=session.sessionFile;session.destroy();
  const resumed=new FakeCodex();resumed.id=fake.id;
  const next=new CodexSession({cwd,sessionFile:file,nativeId:fake.id},()=>{},resumed);
  t.after(()=>next.destroy());await next.start();
  assert.equal(resumed.calls[0].method,'thread/resume');
  assert.equal(resumed.calls[0].params.threadId,fake.id);
  assert.equal(resumed.calls[0].params.path,undefined);assert.equal(resumed.calls[0].params.history,undefined);
});
test('only the known empty-history diagnostic with our durable native file is accepted', async t => {
  const {root,cwd}=await fixture(t);
  const previous=process.env.OMP_WEB_CODEX_HOME;process.env.OMP_WEB_CODEX_HOME=join(root,'native');
  t.after(()=>{if(previous===undefined)delete process.env.OMP_WEB_CODEX_HOME;else process.env.OMP_WEB_CODEX_HOME=previous});
  const fake=new FakeCodex(),path=join(root,'native','sessions',`rollout-${fake.id}.jsonl`);
  await mkdir(join(root,'native','sessions'),{recursive:true});await writeFile(path,'synthetic native header\n');
  fake.readError='list_turns is not supported yet';fake.startResult={thread:{id:fake.id,status:{type:'idle'},path}};
  const session=new CodexSession({cwd},()=>{},fake);t.after(()=>session.destroy());await session.start();
  const failed=new FakeCodex();failed.readError='authentication failed';
  const rejected=new CodexSession({cwd},()=>{},failed);await assert.rejects(rejected.start(),/authentication failed/);
  const noFile=new FakeCodex();noFile.readError='list_turns is not supported yet';
  await assert.rejects(new CodexSession({cwd},()=>{},noFile).start(),/list_turns/);
});

test('early deltas/finals are buffered by turn identity and committed only once', async t => {
  const { session,fake,events }=await fixture(t);
  fake.early=()=>{
    fake.frame('item/agentMessage/delta',{itemId:'a',delta:'hello'});
    fake.frame('item/completed',{item:{type:'agentMessage',id:'a',text:'hello'}});
    fake.frame('turn/completed',{turn:{id:fake.turn,status:'completed',items:[{type:'agentMessage',id:'a',text:'hello'}]}});
  };
  await session.send({type:'prompt',message:'hello'});
  assert.deepEqual(finalTexts(events),['hello']);assert.ok(events.some(e=>e.type==='message_update'));
  assert.equal(session.isRunning(),false);
  assert.equal((await session.send({type:'get_messages'})).messages.length,2);
});
test('subagent and stale-turn events cannot enter history or settle the current turn', async t => {
  const {session,fake,events}=await fixture(t);await session.send({type:'prompt',message:'hello'});
  fake.frame('item/completed',{threadId:randomUUID(),item:{type:'agentMessage',id:'foreign',text:'PRIVATE'}});
  fake.frame('turn/completed',{turn:{id:randomUUID(),status:'completed',items:[]}});
  assert.equal(session.isRunning(),true);assert.deepEqual(finalTexts(events),[]);fake.complete();
});
test('stop acknowledgement alone does not settle a turn, including stop during start', async t => {
  const {session,fake}=await fixture(t);fake.holdStart=true;
  const prompt=session.send({type:'prompt',message:'hello'});await tick();
  await session.send({type:'abort'});assert.equal(session.isRunning(),true);
  assert.equal(fake.calls.filter(c=>c.method==='turn/interrupt').length,0);
  fake.releaseStart();await prompt;
  assert.equal(fake.calls.filter(c=>c.method==='turn/interrupt').length,1);
  assert.equal(session.isRunning(),true);fake.complete('interrupted');assert.equal(session.isRunning(),false);
});
test('approval is deny-first, replays on reconnect and allows only once with the original RPC ID', async t => {
  const {session,fake,events}=await fixture(t);await session.send({type:'prompt',message:'test'});
  fake.frame('item/commandExecution/requestApproval',{itemId:'cmd',command:'printf harmless'},71);
  const dialog=events.find(e=>e.type==='extension_ui_request'&&e.method==='select');assert.ok(dialog);
  assert.match(dialog.options[0],/Deny/);
  const replay=[];const unsubscribe=session.onEvent(e=>replay.push(e));unsubscribe();assert.equal(replay.find(e=>e.type==='extension_ui_request')?.id,dialog.id);
  await session.send({type:'extension_ui_response',id:dialog.id,value:dialog.options[1]});await tick();
  assert.deepEqual(fake.replies.at(-1),{id:71,result:{decision:'accept'}});
  assert.ok(events.some(e=>e.method==='cancel'&&e.targetId===dialog.id));fake.complete();
});
test('native-resolved requests withdraw the UI without a second response', async t => {
  const {session,fake,events}=await fixture(t);await session.send({type:'prompt',message:'test'});
  fake.frame('item/commandExecution/requestApproval',{itemId:'cmd',command:'true'},72);
  const dialog=events.find(e=>e.method==='select');
  fake.frame('serverRequest/resolved',{requestId:72});await tick();
  await session.send({type:'extension_ui_response',id:dialog.id,value:dialog.options[1]});await tick();
  assert.equal(fake.replies.length,0);assert.ok(events.some(e=>e.method==='cancel'&&e.targetId===dialog.id));fake.complete();
});
test('requests resolved before turn/start replies never open a stale approval', async t => {
  const {session,fake,events}=await fixture(t);
  fake.early=()=>{fake.frame('item/commandExecution/requestApproval',{command:'true',itemId:'cmd'},73);fake.frame('serverRequest/resolved',{requestId:73});};
  await session.send({type:'prompt',message:'test'});
  assert.equal(events.filter(e=>e.method==='select').length,0);fake.complete();
});
test('stop cancels pending approvals and a late browser answer cannot approve them', async t => {
  const {session,fake,events}=await fixture(t);await session.send({type:'prompt',message:'test'});
  fake.frame('item/commandExecution/requestApproval',{itemId:'cmd',command:'true'},74);
  const dialog=events.find(e=>e.method==='select');await session.send({type:'abort'});await tick();
  await session.send({type:'extension_ui_response',id:dialog.id,value:dialog.options[1]});await tick();
  assert.deepEqual(fake.replies.at(-1),{id:74,result:{decision:'cancel'}});fake.complete('interrupted');
});
test('blind file changes, root grants and unsupported requests fail closed', async t => {
  const {session,fake,events}=await fixture(t);await session.send({type:'prompt',message:'test'});
  fake.frame('item/fileChange/requestApproval',{itemId:'no-diff'},75);
  fake.frame('attestation/generate',{},76);await tick();
  assert.deepEqual(fake.replies.at(-1),{id:75,result:{decision:'cancel'}});
  assert.equal(fake.errors.at(-1).id,76);assert.equal(events.filter(e=>e.method==='select').length,0);fake.complete();
});
test('model switching uses the native catalog and applies the selection to the next turn', async t => {
  const {session,fake}=await fixture(t);
  await assert.rejects(session.send({type:'set_model',provider:'openai',modelId:'other-codex'}));
  await assert.rejects(session.send({type:'set_model',provider:'codex-cli',modelId:'absent'}));
  await session.send({type:'set_model',provider:'codex-cli',modelId:'other-codex'});
  await session.send({type:'prompt',message:'test'});
  assert.equal(fake.calls.find(c=>c.method==='turn/start').params.model,'other-codex');
  await assert.rejects(session.send({type:'prompt',message:'second'}));fake.complete();
});
test('images are carried as data URLs, without a temporary shared image file', async t => {
  const {session,fake}=await fixture(t);
  await session.send({type:'prompt',message:'image',images:[{type:'image',mimeType:'image/png',data:'aGVsbG8='}]});
  assert.equal(fake.calls.find(c=>c.method==='turn/start').params.input[1].url,'data:image/png;base64,aGVsbG8=');fake.complete();
});
test('native policy is not rewritten, and wrong thread identity is rejected', async t => {
  const {cwd,fake}=await fixture(t);
  const bad=new FakeCodex();bad.startResult={approvalPolicy:'never',sandbox:{type:'dangerFullAccess'}};
  const session=new CodexSession({cwd},()=>{},bad);t.after(()=>session.destroy());await session.start();
  assert.equal(bad.calls[0].params.approvalPolicy,undefined);assert.equal(bad.calls[0].params.sandbox,undefined);assert.equal(bad.calls[0].params.approvalsReviewer,undefined);
  const wrong=new CodexSession({cwd,nativeId:fake.id},()=>{},new FakeCodex());await assert.rejects(wrong.start(),/thread ID/);
});
test('model pagination rejects repeated cursors', async () => {
  const client={request:async()=>({data:[{model:'test'}],nextCursor:'same'})};
  await assert.rejects(listCodexModels(client),/pagination/);
});
test('Codex retains native provider environment but drops web and parent-session overrides', () => {
  const names=['ANTHROPIC_AUTH_TOKEN','OPENAI_API_KEY','PI_MODEL','OMP_WEB_CODEX_HOME'];
  const old=Object.fromEntries(names.map(k=>[k,process.env[k]]));
  try {
    Object.assign(process.env,{ANTHROPIC_AUTH_TOKEN:'fake',OPENAI_API_KEY:'fake',PI_MODEL:'wrong',OMP_WEB_CODEX_HOME:'/tmp/fake-codex-home'});
    const env=codexChildEnvironment();assert.equal(env.CODEX_HOME,'/tmp/fake-codex-home');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN,'fake');assert.equal(env.OPENAI_API_KEY,'fake');
    assert.equal(env.PI_MODEL,undefined);assert.equal(env.OMP_WEB_CODEX_HOME,undefined);
    assert.throws(()=>getCodexWebDir({...process.env,OMP_WEB_CODEX_STATE_DIR:'/tmp/fake-codex-home'}),/separate/);
  } finally {for(const key of names){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];}}
});
test('transport frames UTF-8 at LF and does not mistake server requests for responses', async t => {
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;child.signalCode=null;
  const sent=[];child.stdin=new Writable({write(chunk,encoding,callback){
    const frame=JSON.parse(chunk.toString());sent.push(frame);
    if(frame.method==='initialize')queueMicrotask(()=>child.stdout.write(JSON.stringify({id:frame.id,result:{}})+'\n'));
    callback();
  }});
  const client=new CodexRpcClient('/tmp',()=>child);t.after(()=>client.destroy());
  const incoming=[];client.onFrame(frame=>incoming.push(frame));await client.start();
  assert.equal(sent[1].method,'initialized');
  const request=client.request('test',{});const id=sent.at(-1).id;
  const serverRequest={id,method:'item/tool/call',params:{text:'中文\u2028line'}};
  for(const byte of Buffer.from(JSON.stringify(serverRequest)+'\n'))child.stdout.write(Buffer.from([byte]));
  assert.equal(incoming[0].params.text,'中文\u2028line');
  child.stdout.write(JSON.stringify({id,result:{ok:true}})+'\n');assert.deepEqual(await request,{ok:true});
});

test('Codex context usage follows native thread token updates for this thread only', async t => {
  const { session, fake, events } = await fixture(t);
  assert.equal((await session.send({ type: 'get_state' })).contextUsage, null, 'unknown until Codex reports usage');
  const tokenUsage = (last, window = 272000) => ({
    total: { totalTokens: 999999, inputTokens: 900000, cachedInputTokens: 800000, cacheWriteInputTokens: 0, outputTokens: 99999, reasoningOutputTokens: 1 },
    last: { totalTokens: last, inputTokens: last - 1000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1000, reasoningOutputTokens: 0 },
    modelContextWindow: window,
  });
  await session.send({ type: 'prompt', message: 'measure' });
  fake.frame('thread/tokenUsage/updated', { tokenUsage: tokenUsage(68000) });
  fake.frame('thread/tokenUsage/updated', { threadId: 'child', tokenUsage: tokenUsage(5) });
  fake.complete();
  const usage = (await session.send({ type: 'get_state' })).contextUsage;
  assert.equal(usage.contextWindow, 272000);
  assert.equal(usage.tokens, 68000, 'the latest request, never cumulative billing totals');
  assert.equal((await session.send({ type: 'get_session_stats' })).contextUsage.tokens, 68000);
  assert.deepEqual(events.filter(event => event.type === 'context_usage').map(event => [event.sessionId, event.contextUsage.tokens]), [[session.sessionId, 68000]]);
  // Late thread metadata after completion is still this thread's context.
  fake.frame('thread/tokenUsage/updated', { tokenUsage: tokenUsage(70000) });
  assert.equal((await session.send({ type: 'get_state' })).contextUsage.tokens, 70000);
  await session.send({ type: 'set_model', provider: 'codex-cli', modelId: 'other-codex' });
  assert.equal((await session.send({ type: 'get_state' })).contextUsage, null, 'a new model reports its own window');
});
