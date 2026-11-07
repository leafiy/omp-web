// Usage: node scripts/check-chat-ui.mjs http://127.0.0.1:<isolated-preview-port>
// Requires an existing Chrome installation. All APIs are synthetic; only assets reach the preview.
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const root=await mkdtemp(join(tmpdir(),'omp-web-ui-check-')),upstream=new URL(process.argv[2]||'http://127.0.0.1:32274');
assert.ok(['127.0.0.1','localhost'].includes(upstream.hostname),'Use an isolated local preview');
const cwd='/synthetic/ui-project',uuid='12345678-1234-4123-8123-123456789abc';
let engine='claude',busy=false,failSend=false,delaySend=0,lateRecall=false,serial=0,revision=0,taskReads=0;
const queue=[],messages=[],requests=[],streams=new Set(),checks=[],errors=[];let tasks=[];
const sid=()=>engine==='omp'?uuid:engine+':'+uuid;
const model=()=>({id:'test-native',provider:engine==='claude'?'claude-code':'test'});
const queued=()=>({steering:queue.filter(q=>q.kind==='steer').map(q=>q.text),followUp:queue.filter(q=>q.kind==='follow_up').map(q=>q.text)});
const snapshot=()=>({epoch:engine+'-process',revision,coverage:'native',tasks});
const state=()=>({sessionId:sid(),engine,model:model(),isPromptRunning:busy,isStreaming:busy,isSettled:!busy,tasks:snapshot(),supportsSteering:engine==='claude',queuedMessages:queued(),queuedItems:engine==='claude'?queue:[],isBashRunning:false,isCompacting:false});
const info=()=>({id:sid(),engine,cwd,projectRoot:cwd,path:'/synthetic/history.jsonl',name:'UI test',created:new Date().toISOString(),modified:new Date().toISOString(),messageCount:messages.length,firstMessage:messages[0]?.content?.[0]?.text||'test'});
const context=()=>({messages,entryIds:messages.map((_,i)=>String(i)),thinkingLevel:'off',model:{provider:model().provider,modelId:model().id}});
const emit=e=>{for(const r of streams)r.write(`data: ${JSON.stringify(e)}\n\n`)};
const emitQueue=()=>emit({type:'queue_update',...queued(),items:engine==='claude'?queue:[]});
function message(role,text){const m={role,content:[{type:'text',text}],timestamp:Date.now(),...(role==='assistant'?{provider:model().provider,model:model().id}:{})};messages.push(m);emit({type:'message_end',message:m})}
function settle(){message('assistant','PARENT_FINISHED');busy=false;emit({type:'agent_end'});emit({type:'prompt_done'});emit({type:'agent_settled'})}
const tools=['pi','omp','claude','codex'].map(tool=>({tool,available:true,phase:'idle',installedVersion:'test',output:''}));
const proxy=http.createServer(async(req,res)=>{
 const u=new URL(req.url,'http://localhost'),path=decodeURIComponent(u.pathname);
 if(!path.startsWith('/api/')){const n=http.request({hostname:upstream.hostname,port:upstream.port,path:req.url,method:req.method,headers:{...req.headers,host:upstream.host}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)});n.on('error',()=>{res.writeHead(502);res.end()});req.pipe(n);return}
 const json=(data,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data))};
 const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};requests.push({path,method:req.method,...body});
 if(path===`/api/agent/${sid()}/events`){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});res.write(`data: ${JSON.stringify({type:'connected',sessionId:sid()})}\n\n`);res.write(`data: ${JSON.stringify({type:'task_snapshot',snapshot:snapshot()})}\n\n`);res.write(`data: ${JSON.stringify({type:'queue_update',...queued(),items:engine==='claude'?queue:[]})}\n\n`);streams.add(res);res.on('close',()=>streams.delete(res));return}
 if(path.endsWith('/events')){res.writeHead(204);res.end();return}
 if(path==='/api/engines')return json({engines:['omp','pi','claude','codex'].map(engine=>({engine,installed:['claude','omp'].includes(engine)}))});
 if(path==='/api/home')return json({home:'/synthetic'});
 if(path==='/api/cwd/validate'||path==='/api/default-cwd')return json({success:true,cwd});
 if(path==='/api/worktrees')return json({cwd,projectRoot:cwd,isGit:false,isTopLevel:false,worktrees:[]});
 if(path==='/api/project-trust')return json({requiresTrust:false,trusted:false});
 if(path==='/api/sessions')return json({sessions:messages.length?[info()]:[],runningSessionIds:busy?[sid()]:[]});
 if(path===`/api/sessions/${sid()}`)return json({sessionId:sid(),info:info(),filePath:'/synthetic/history.jsonl',tree:[],leafId:String(messages.length),context:context()});
 if(path===`/api/sessions/${sid()}/context`)return json({context:context()});
 if(path===`/api/sessions/${sid()}/state`)return json({running:true,state:state()});
 if(path==='/api/agent/running')return json({runningSessionIds:busy?[sid()]:[]});
 if(path==='/api/models')return json({models:{},modelList:[{...model(),name:'Test model'}],defaultModel:null,thinkingLevels:{},thinkingLevelMaps:{},thinkingLevelPins:{}});
 if(path==='/api/agent/new')return json({success:true,engine,sessionId:sid(),model:{provider:model().provider,modelId:model().id}});
 if(path===`/api/agent/${sid()}/tasks/child`){taskReads++;return json({task:tasks[0],available:true,truncated:false,messages:[{role:'user',text:'Child assignment'},{role:'assistant',text:'CHILD_PRIVATE_CONVERSATION'}]})}
 if(path===`/api/agent/${sid()}`){
  if(req.method==='GET')return json({running:true,state:state()});
  if(body.type==='get_state')return json({success:true,data:state()});
  if(body.type==='get_commands')return json({success:true,data:{commands:[]}});
  if(body.type==='get_messages')return json({success:true,data:{messages}});
  if(body.type==='prompt'){
   if(failSend){failSend=false;return json({error:'SYNTHETIC_SEND_FAILED'},503)}
   busy=true;emit({type:'agent_start'});emit({type:'agent_capabilities',supportsSteering:true});message('user',body.message);
   if(delaySend){const ms=delaySend;delaySend=0;setTimeout(()=>json({success:true,data:null}),ms)}else json({success:true,data:null});return;
  }
  if(['steer','follow_up'].includes(body.type)){queue.push({id:'queued-'+(++serial),kind:body.type,text:body.message});json({success:true,data:null});emitQueue();return}
  if(body.type==='recall_queued_message'||body.type==='remove_queued_message'){
   const index=queue.findIndex(q=>body.id?q.id===body.id:q.text===body.message&&q.kind===(body.queue==='steering'?'steer':'follow_up'));
   const item=index>=0?queue.splice(index,1)[0]:null;
   const removed=!!item&&!lateRecall;if(lateRecall&&item)message('user',item.text);lateRecall=false;
   json({success:true,data:{removed,...(removed?{text:item.text,kind:item.kind}:{})}});emitQueue();return;
  }
  return json({success:true,data:null});
 }
 if(path==='/api/tools/update')return json({tools,job:null});
 if(path==='/api/native-skills')return json({engine:u.searchParams.get('engine'),status:'ok',note:'SHOULD_NOT_RENDER',items:[{name:'example-skill',description:'SHOULD_NOT_RENDER',kind:'skill',invocation:'/example'}]});
 if(path==='/api/usage')return json({subscriptions:[{engine:'claude',plan:'pro',weekly:[],totalTokens:null,tokenScope:'account',note:'SHOULD_NOT_RENDER',noteEn:'SHOULD_NOT_RENDER',checkedAt:new Date().toISOString()}]});
 return json({files:[],entries:[],directories:[]});
});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${proxy.address().port}`;
const profile=await mkdtemp(join(root,'ui-browser-')),chrome=spawn('/usr/bin/google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ws,n=0;const pending=new Map();
function call(method,params={}){return new Promise((resolve,reject)=>{const id=++n,t=setTimeout(()=>reject(Error(method+' timeout')),15000);pending.set(id,{resolve:r=>{clearTimeout(t);resolve(r)},reject:e=>{clearTimeout(t);reject(e)}});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
async function wait(expression,label){for(let i=0;i<150;i++){if(await evaluate(expression))return;await sleep(100)}throw Error('UI timeout '+label)}
const has=text=>`Boolean(document.body?.innerText.includes(${JSON.stringify(text)}))`;
const button=(text,scope='document')=>`[...${scope}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})`;
async function fill(text){await evaluate(`(()=>{const t=document.querySelector('textarea');t.focus();t.select()})()`);await call('Input.insertText',{text})}
async function click(text,scope='document'){await evaluate(`${button(text,scope)}.click()`)}
const draft=()=>evaluate(`document.querySelector('textarea').value`);
try{
 let port;for(let i=0;i<100;i++){try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break}catch{await sleep(100)}}
 const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
 ws.onmessage=({data})=>{const m=JSON.parse(data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text)};
 await call('Runtime.enable');await call('Page.enable');await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 const init=await call('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('pi-locale','zh-CN');localStorage.setItem('omp-web:new-chat-engine','claude')`});
 await call('Page.navigate',{url:base+'/?cwd='+encodeURIComponent(cwd)});await wait(`!!document.querySelector('textarea')`,'composer');
 await wait(`document.querySelector('select[aria-label="聊天引擎"] option[value="pi"]').disabled`,'installed engine gating');
 assert.equal(await evaluate(`document.querySelector('select[aria-label="聊天引擎"] option[value="pi"]').textContent.trim()`),'Pi（未安装）');
 assert.ok(await evaluate(`(()=>{const a=document.querySelector('select[aria-label="聊天引擎"]').getBoundingClientRect(),b=document.querySelector('button[title="Choose theme"]').getBoundingClientRect();return a.right<=b.left&&Math.abs(a.y-b.y)<10})()`));
 await sleep(300);assert.equal(await evaluate(has('仅 Git 仓库根目录')),false);assert.equal(await evaluate(has('上传、新建和空白处粘贴使用当前目录')),false);
 checks.push('Engine selector precedes theme; missing agents disabled/labeled; non-Git and file-browser hints removed');
 for(const [label,title,forbidden] of [['设置','engine-settings-title','登录、技能和插件'],['技能','native-skills-title','管理方式与限制'],['用量','subscription-usage-title','统计范围与说明']]){
  await click(label);await wait(`!!document.querySelector('#${title}')`,label);await sleep(200);
  assert.equal(await evaluate(has(forbidden)),false);assert.equal(await evaluate(has('SHOULD_NOT_RENDER')),false);
  await click('关闭','document.querySelector("[role=dialog]")');
 }
 checks.push('Settings, skills and usage keep data/actions without explanatory paragraphs');
 await fill('DRAFT_RELOAD');await call('Page.removeScriptToEvaluateOnNewDocument',{identifier:init.identifier});await call('Page.reload');await wait(`document.querySelector('textarea')?.value==='DRAFT_RELOAD'`,'unsent draft survives reload');
 failSend=true;await click('发送');await wait(has('SYNTHETIC_SEND_FAILED'),'send error');assert.equal(await draft(),'DRAFT_RELOAD');await wait(`!document.querySelector('button[title="停止 Agent"]')`,'failed send settles');
 await fill('FIRST_SENT');await click('发送');await wait(`document.querySelector('textarea')?.value===''`,'accepted send clears');settle();await wait(has('PARENT_FINISHED'),'settled history');
 await call('Page.reload');await wait(`!!document.querySelector('button[aria-label="编辑"]')`,'history edit');assert.equal(await draft(),'');
 await evaluate(`document.querySelector('button[aria-label="编辑"]').click()`);await wait(`document.querySelector('textarea').value==='FIRST_SENT'`,'quick edit restores');assert.equal(messages.filter(m=>m.role==='user').length,1);
 await fill('KEEP_DRAFT');await evaluate(`document.querySelector('button[aria-label="编辑"]').click()`);await wait(`!!document.querySelector('[data-inline-confirmation]')`,'replace confirmation');await click('取消','document.querySelector("[data-inline-confirmation]")');assert.equal(await draft(),'KEEP_DRAFT');
 await evaluate(`document.querySelector('button[aria-label="编辑"]').click()`);await click('替换草稿文字','document.querySelector("[data-inline-confirmation]")');await wait(`document.querySelector('textarea').value==='FIRST_SENT'`,'confirmed edit');
 await fill('EDITED_SENT');await click('发送');await wait(`document.querySelector('textarea').value===''`,'edited send');settle();assert.equal(messages.filter(m=>m.role==='user')[0].content[0].text,'FIRST_SENT');
 checks.push('Draft survives reload/failure and clears after acceptance; Edit never rewrites history; existing draft protected');
 delaySend=700;await fill('DELAYED_SENT');await click('发送');await fill('NEWER_DRAFT');await sleep(900);assert.equal(await draft(),'NEWER_DRAFT');settle();checks.push('Delayed send acknowledgement cannot clear a newer edit');
 await fill('RUN');await click('发送');await wait(`!!${button('引导')}`,'steer controls');await wait(`document.querySelector('textarea').value===''`,'run accepted');
 await fill('STEER_PENDING');await click('引导');await wait(has('STEER_PENDING'),'pending steer');await wait(`document.querySelector('textarea').value===''`,'steer accepted');await fill('DRAFT_UNTOUCHED');
 const row=`document.querySelector('[title="STEER_PENDING"]')`;
 await evaluate(`(()=>{const b=${button('撤回',row)};b.click();b.click()})()`);await wait(has('消息已撤回'),'withdraw success');assert.equal(await draft(),'DRAFT_UNTOUCHED');assert.equal(queue.length,0);assert.equal(requests.filter(r=>r.type==='recall_queued_message').length,1);
 assert.equal(messages.some(m=>JSON.stringify(m).includes('STEER_PENDING')),false);
 await fill('STEER_LATE');await click('引导');await wait(`document.querySelector('textarea').value===''`,'late steer queued');await fill('CURRENT_DRAFT');lateRecall=true;await click('撤回',`document.querySelector('[title="STEER_LATE"]')`);await wait(has('无法撤回'),'consumed message refusal');assert.equal(await draft(),'CURRENT_DRAFT');assert.equal(requests.filter(r=>r.type==='abort').length,0);
 checks.push('Claude pending steer withdraws once without stopping or changing draft; consumed steer refuses honestly');
 tasks=[{id:'child',title:'Review detail',kind:'local_agent',status:'running',active:true,updatedAt:Date.now()}];revision++;emit({type:'task_snapshot',snapshot:snapshot()});settle();
 await wait(has('仍有 1 个'),'background task');await evaluate(`[...document.querySelectorAll('summary')].find(s=>s.textContent.includes('子 agent')).click()`);
 await evaluate(`document.querySelector('button[aria-label="Review detail · 子 agent 对话"]').click()`);await wait(`document.querySelector('#file-panel')?.innerText.includes('CHILD_PRIVATE_CONVERSATION')`,'child drawer');
 assert.equal(await evaluate(`(()=>{const c=document.body.cloneNode(true);c.querySelector('#file-panel').remove();return c.innerText?.includes('CHILD_PRIVATE_CONVERSATION')||c.textContent.includes('CHILD_PRIVATE_CONVERSATION')})()`),false);
 await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(200);assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));
 await call('Page.captureScreenshot',{format:'png'}).then(r=>writeFile(join(root,'ui-mobile-task.png'),Buffer.from(r.data,'base64')));
 await evaluate(`document.querySelector('button[aria-label="关闭 Review detail"]').click()`);const reads=taskReads;await sleep(3400);assert.equal(taskReads,reads,'closed task panel must stop polling');
 assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));
 checks.push('Child conversation opens in right panel only, fits mobile, and stops polling on close');
 await call('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 engine='omp';messages.length=0;tasks=[];revision=0;
 await evaluate(`(()=>{const s=document.querySelector('select[aria-label="聊天引擎"]');s.value='omp';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
 await wait(`document.querySelector('select[aria-label="聊天引擎"]').value==='omp'`,'switch OMP');await fill('OMP_RUN');await click('发送');await wait(`document.querySelector('textarea').value===''`,'OMP run');await fill('OMP_STEER');await click('引导');await wait(`document.querySelector('textarea').value===''`,'OMP steer');await click('撤回',`document.querySelector('[title="OMP_STEER"]')`);await wait(`!document.querySelector('[title="OMP_STEER"]')`,'OMP native text withdrawal');
 assert.ok(requests.some(r=>r.type==='remove_queued_message'&&r.queue==='steering'&&r.message==='OMP_STEER'));assert.equal(requests.filter(r=>r.type==='abort').length,0);
 checks.push('OMP withdrawal uses its native queue+text command rather than invented UUIDs');
 assert.deepEqual(errors,[]);await writeFile(join(root,'browser-ui-result.json'),JSON.stringify({passed:true,checks,realModelRequests:0},null,2));console.log(JSON.stringify({passed:true,checks,reportDirectory:root}));
}catch(error){await writeFile(join(root,'browser-ui-result.json'),JSON.stringify({passed:false,error:String(error),checks,errors,requests,draft:await evaluate(`document.querySelector('textarea')?.value`),storage:await evaluate(`Object.fromEntries(Object.entries(localStorage).filter(([k])=>k.startsWith('omp-web:draft:')))`),body:await evaluate(`document.body?.innerText.slice(-6000)||''`)},null,2));throw error}
finally{ws?.close();chrome.kill('SIGTERM');for(const r of streams)r.end();proxy.closeAllConnections();await new Promise(r=>proxy.close(r));await new Promise(r=>chrome.exitCode!==null?r():chrome.once('exit',r));await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200})}
