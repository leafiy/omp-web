// node scripts/check-follow-up-ui.mjs http://127.0.0.1:<isolated-preview-port>
// Real FollowUpSession + compiled UI, fake native adapters; no model/CLI calls.
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createJiti} from 'jiti';
const {FollowUpSession}=await createJiti(import.meta.url).import('../lib/follow-up-session.ts');
const root=await mkdtemp(join(tmpdir(),'omp-web-follow-up-check-')),upstream=new URL(process.argv[2]);
assert.ok(['127.0.0.1','localhost'].includes(upstream.hostname));
const cwd='/synthetic/follow-up',uuid='12345678-1234-4123-8123-123456789abc',checks=[],errors=[];
let engine='claude',session,native,holdNextFollowUp=false,releaseAck;const streams=new Set();
class Native {
 constructor(engine){this.engine=engine;this.sessionId=engine==='omp'?uuid:engine+':'+uuid;this.sessionFile='/synthetic/history.jsonl';this.cwd=cwd;}
 alive=true;busy=false;messages=[];prompts=[];listeners=new Set();steering=[];
 start=async()=>{};isAlive=()=>this.alive;isRunning=()=>this.busy;getActiveLeafId=()=>undefined;waitUntilReady=async()=>{};
 onDestroy=fn=>{this.destroyed=fn};
 onEvent=fn=>{this.listeners.add(fn);return()=>this.listeners.delete(fn)};
 emit=e=>{for(const fn of this.listeners)fn(e)};
 message=(role,text)=>{const message={role,content:[{type:'text',text}],timestamp:Date.now()};this.messages.push(message);this.emit({type:'message_end',message})};
 send=async c=>{
  if(c.type==='get_state')return {sessionId:this.sessionId,engine:this.engine,model:{provider:'test',id:'test-model'},isStreaming:this.busy,isPromptRunning:this.busy,isSettled:!this.busy,supportsSteering:this.engine!=='codex',queuedMessages:{steering:this.steering,followUp:[]},queuedItems:[]};
  if(c.type==='prompt'){assert.equal(this.busy,false);this.busy=true;this.prompts.push(c.message);this.emit({type:'agent_start'});this.message('user',c.message);return null}
  if(c.type==='get_commands')return {commands:[]};
  if(c.type==='get_messages')return {messages:this.messages};
  if(c.type==='abort'){this.finish();return null}
  return null;
 };
 finish=()=>{this.message('assistant','MAIN_DONE');this.busy=false;this.emit({type:'agent_end'});this.emit({type:'prompt_done'});this.emit({type:'agent_settled'})};
 destroy=()=>{this.alive=false;this.destroyed?.()};shutdown=async()=>this.destroy();
}
const sid=()=>session.sessionId;
const info=()=>({id:sid(),engine,cwd,projectRoot:cwd,path:'/synthetic/history.jsonl',name:'Follow-up test',created:new Date().toISOString(),modified:new Date().toISOString(),messageCount:native.messages.length,firstMessage:'MAIN'});
const context=()=>({messages:native.messages,entryIds:native.messages.map((_,i)=>String(i)),thinkingLevel:'off',model:{provider:'test',modelId:'test-model'}});
const proxy=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://localhost'),path=decodeURIComponent(u.pathname);
 if(!path.startsWith('/api/')){const n=http.request({hostname:upstream.hostname,port:upstream.port,path:req.url,method:req.method,headers:{...req.headers,host:upstream.host}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)});n.on('error',()=>{res.writeHead(502);res.end()});req.pipe(n);return}
 const json=(v,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(v))};
 try{
  const chunks=[];for await(const b of req)chunks.push(b);const body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
  if(path===`/api/agent/${sid()}/events`){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});res.write(`data: ${JSON.stringify({type:'connected',sessionId:sid()})}\n\n`);streams.add(res);const off=session.onEvent(e=>res.write(`data: ${JSON.stringify(e)}\n\n`));res.on('close',()=>{off();streams.delete(res)});return}
  if(path.endsWith('/events')){res.writeHead(204);res.end();return}
  if(path==='/api/engines')return json({engines:['omp','pi','claude','codex'].map(engine=>({engine,installed:true}))});
  if(path==='/api/home')return json({home:'/synthetic'});
  if(path==='/api/cwd/validate'||path==='/api/default-cwd')return json({success:true,cwd});
  if(path==='/api/sessions')return json({sessions:native.messages.length?[info()]:[],runningSessionIds:session.isRunning()?[sid()]:[]});
  if(path===`/api/sessions/${sid()}`)return json({sessionId:sid(),info:info(),filePath:'/synthetic/history.jsonl',tree:[],leafId:String(native.messages.length),context:context()});
  if(path===`/api/sessions/${sid()}/context`)return json({context:context()});
  if(path===`/api/sessions/${sid()}/state`)return json({running:true,state:await session.send({type:'get_state'})});
  if(path==='/api/agent/running')return json({runningSessionIds:session.isRunning()?[sid()]:[]});
  if(path==='/api/models')return json({models:{},modelList:[{provider:'test',id:'test-model',name:'Test model'}],defaultModel:null,thinkingLevels:{},thinkingLevelMaps:{},thinkingLevelPins:{}});
  if(path==='/api/worktrees')return json({isGit:false,isTopLevel:false,projectRoot:cwd,worktrees:[]});
  if(path==='/api/project-trust')return json({requiresTrust:false,trusted:false});
  if(path==='/api/agent/new'){assert.equal(body.engine,engine);return json({success:true,sessionId:sid(),engine,model:{provider:'test',modelId:'test-model'}})}
  if(path===`/api/agent/${sid()}`){
   if(req.method==='GET')return json({running:true,state:await session.send({type:'get_state'})});
   const data=await session.send(body);
   if(body.type==='follow_up'&&holdNextFollowUp){holdNextFollowUp=false;await new Promise(resolve=>{releaseAck=()=>{releaseAck=undefined;json({success:true,data});resolve()}});return}
   return json({success:true,data});
  }
  return json({files:[],entries:[],directories:[]});
 }catch(e){json({error:String(e)},500)}
});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${proxy.address().port}`;
const profile=await mkdtemp(join(root,'browser-')),chrome=spawn('/usr/bin/google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ws,n=0;const pending=new Map();
function call(method,params={}){return new Promise((resolve,reject)=>{const id=++n,t=setTimeout(()=>reject(Error(method+' timeout')),15000);pending.set(id,{resolve:r=>{clearTimeout(t);resolve(r)},reject:e=>{clearTimeout(t);reject(e)}});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
async function wait(expression,label){for(let i=0;i<150;i++){if(await evaluate(expression))return;await sleep(100)}throw Error('UI timeout '+label)}
const button=(text,scope='document')=>`[...${scope}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})`;
const row=text=>`document.querySelector('[title="${text}"]')`;
async function fill(text){await evaluate(`(()=>{const t=document.querySelector('textarea');t.focus();t.select()})()`);await call('Input.insertText',{text})}
async function click(text,scope='document'){await wait(`${button(text,scope)} && !${button(text,scope)}.disabled`,'enabled '+text);await evaluate(`${button(text,scope)}.click()`)}
try{
 let port;for(let i=0;i<100;i++){try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break}catch{await sleep(100)}}
 const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
 ws.onmessage=({data})=>{const m=JSON.parse(data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text)};
 await call('Runtime.enable');await call('Page.enable');
 await call('Page.addScriptToEvaluateOnNewDocument',{source:`window.__tones=0;window.AudioContext=class {state='running';currentTime=0;destination={};resume(){return Promise.resolve()}createOscillator(){return {connect(){},frequency:{value:0},start(){window.__tones++},stop(){}}}createGain(){return {connect(){},gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}}}}};`});
 for(const current of ['omp','pi','claude','codex']){
  session?.destroy();engine=current;native=new Native(engine);session=new FollowUpSession(native,()=>{});await session.start();
  await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  const init=await call('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.clear();localStorage.setItem('pi-locale','zh-CN');localStorage.setItem('omp-web:new-chat-engine',${JSON.stringify(engine)})`});
  await call('Page.navigate',{url:base+'/?cwd='+encodeURIComponent(cwd)});await wait(`!!document.querySelector('textarea')`,'composer');
  await wait(`document.querySelector('select[aria-label="聊天引擎"]')?.value===${JSON.stringify(engine)}`,'selected engine '+engine);
  await fill('MAIN');await click('发送');await wait(`!!${button('后续消息')}`,'follow-up available for '+engine);await wait(`document.querySelector('textarea').value===''`,'main accepted');
  // Editing and copying use the exact same hover container and base geometry.
  assert.ok(await evaluate(`(()=>{const e=document.querySelector('button[aria-label="编辑"]');return e&&[...e.parentElement.querySelectorAll('button')].some(b=>b.textContent.trim()==='复制')&&getComputedStyle(e.parentElement).opacity==='0'})()`));
  const point=await evaluate(`(()=>{const r=document.querySelector('.sf-user-bubble').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await wait(`getComputedStyle(document.querySelector('button[aria-label="编辑"]').parentElement).opacity==='1'`,'shared hover');
  assert.ok(await evaluate(`(()=>{const e=document.querySelector('button[aria-label="编辑"]'),c=[...e.parentElement.querySelectorAll('button')].find(b=>b.textContent.trim()==='复制');return getComputedStyle(e).height===getComputedStyle(c).height&&getComputedStyle(e).border===getComputedStyle(c).border})()`));
  await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:10,y:890});await wait(`getComputedStyle(document.querySelector('button[aria-label="编辑"]').parentElement).opacity==='0'`,'shared hide');
  holdNextFollowUp=true;await fill('EARLY_RECALL');await click('后续消息');await wait(`!!${row('EARLY_RECALL')}`,'queued before POST acknowledgement');
  await click('取回编辑',row('EARLY_RECALL'));await wait(`!${row('EARLY_RECALL')}&&document.querySelector('textarea').value==='EARLY_RECALL'`,'early recall returns one copy');
  releaseAck();await wait(`!${button('后续消息')}.disabled`,'late acknowledgement');await sleep(100);
  assert.equal(await evaluate(`document.querySelector('textarea').value`),'EARLY_RECALL','late enqueue acknowledgement cannot erase a recovered draft');
  const oldQueue=(await session.send({type:'get_state'})).queuedMessages;
  await fill('WITHDRAW_ME');await click('后续消息');await wait(`!!${row('WITHDRAW_ME')}`,'first queued');await wait(`document.querySelector('textarea').value===''`,'queued ack');
  await fill('EDIT_ME');await click('后续消息');await wait(`!!${row('EDIT_ME')}`,'second queued');
  await call('Page.removeScriptToEvaluateOnNewDocument',{identifier:init.identifier});await call('Page.reload');await wait(`!!${row('WITHDRAW_ME')}&&!!${row('EDIT_ME')}`,'reload queue');
  assert.equal(native.prompts.length,1);
  for(const stream of streams)stream.write(`data: ${JSON.stringify({type:'queue_update',...oldQueue,items:[]})}\n\n`);
  await sleep(100);assert.ok(await evaluate(`!!${row('WITHDRAW_ME')}&&!!${row('EDIT_ME')}`),'old queue snapshot must not erase new pending messages');
  await fill('EXISTING_DRAFT');await click('撤回',row('WITHDRAW_ME'));await wait(`!${row('WITHDRAW_ME')}`,'withdraw');assert.equal(await evaluate(`document.querySelector('textarea').value`),'EXISTING_DRAFT');
  await click('取回编辑',row('EDIT_ME'));await wait(`document.querySelector('textarea').value===${JSON.stringify('EDIT_ME\n\nEXISTING_DRAFT')}`,'recall preserves draft');assert.equal(native.prompts.length,1);
  await fill('KEEP_AND_SEND');await click('后续消息');await wait(`!!${row('KEEP_AND_SEND')}`,'requeue');
  if(engine==='pi'){
   native.steering=['NATIVE_STEER'];native.emit({type:'queue_update',steering:native.steering,followUp:[]});
   await wait(`!!${row('NATIVE_STEER')}&&!!${row('KEEP_AND_SEND')}`,'native steering not hidden by web IDs');
   native.steering=[];native.emit({type:'queue_update',steering:[],followUp:[]});
  }
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(100);assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));
  native.finish();await wait(`document.querySelectorAll('.sf-user-bubble').length===2`,'follow-up delivered');assert.deepEqual(native.prompts,['MAIN','KEEP_AND_SEND']);
  assert.equal(native.messages.some(m=>JSON.stringify(m).includes('WITHDRAW_ME')||JSON.stringify(m).includes('EDIT_ME')||JSON.stringify(m).includes('EARLY_RECALL')),false);
  assert.equal(await evaluate('window.__tones'),0,'no completion sound before queued work finishes');
  native.finish();await wait(`!${row('KEEP_AND_SEND')}`,'queue drained');
  await wait('window.__tones===2','one completion sound after last follow-up');await sleep(100);assert.equal(await evaluate('window.__tones'),2);
  checks.push(engine+': shared Edit/Copy hover, follow-up recall/withdraw after reload, draft protection, one delivery, mobile layout');
 }
 assert.deepEqual(errors,[]);await writeFile(join(root,'result.json'),JSON.stringify({passed:true,checks,realModelRequests:0},null,2));console.log(JSON.stringify({passed:true,checks,reportDirectory:root}));
}catch(error){await writeFile(join(root,'result.json'),JSON.stringify({passed:false,error:String(error),checks,errors,body:await evaluate(`document.body?.innerText.slice(-5000)||''`)},null,2));console.error(root);throw error}
finally{releaseAck?.();session?.destroy();ws?.close();chrome.kill('SIGTERM');for(const r of streams)r.end();proxy.closeAllConnections();await new Promise(r=>proxy.close(r));await new Promise(r=>chrome.exitCode!==null?r():chrome.once('exit',r));await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200})}
