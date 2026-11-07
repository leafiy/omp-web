// Real compiled UI, synthetic APIs. Usage: node scripts/check-mobile-layout.mjs <local-preview-url> [--probe]
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const root=await mkdtemp(join(tmpdir(),'omp-web-mobile-check-')),upstream=new URL(process.argv[2]);
assert.ok(['127.0.0.1','localhost'].includes(upstream.hostname));
const sid='pi:12345678-1234-4123-8123-123456789abc',cwd='/synthetic/mobile';
let busy=false,modelName='GPT-6 Astra',abortCount=0,sendCount=0;const streams=new Set(),errors=[],results=[],violations=[];
const model={provider:'test',id:'test-model'};
const messages=[{role:'user',content:[{type:'text',text:'测试手机布局'}],timestamp:1},{role:'assistant',content:[{type:'text',text:'这是用于检查移动端布局的合成对话。\n\n文字输入区应该占满宽度，操作按钮独立排列。\n\n请检查顶部空白、按钮对齐和键盘展开后的停止按钮。'}],timestamp:2,provider:'test',model:'test-model'}];
const info=()=>({id:sid,engine:'pi',cwd,projectRoot:cwd,path:'/synthetic/history.jsonl',name:'Mobile layout',created:new Date().toISOString(),modified:new Date().toISOString(),messageCount:2,firstMessage:'测试手机布局'});
const context=()=>({messages,entryIds:['u','a'],thinkingLevel:'off',model:{provider:model.provider,modelId:model.id}});
const state=()=>({sessionId:sid,engine:'pi',model,isStreaming:busy,isPromptRunning:busy,isSettled:!busy,isBashRunning:false,isCompacting:false,queuedMessages:{steering:[],followUp:[]},queuedItems:[],systemPrompt:'SYNTHETIC_SYSTEM_PROMPT',contextUsage:{contextWindow:768000,tokens:15000,percent:2},tasks:{epoch:'test',revision:0,coverage:'partial',tasks:[]}});
const emit=e=>{for(const r of streams)r.write(`data: ${JSON.stringify(e)}\n\n`)};
const proxy=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost'),path=decodeURIComponent(url.pathname);
 if(!path.startsWith('/api/')){const n=http.request({hostname:upstream.hostname,port:upstream.port,path:req.url,method:req.method,headers:{...req.headers,host:upstream.host}},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)});n.on('error',()=>{res.writeHead(502);res.end()});req.pipe(n);return}
 const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value))};
 const chunks=[];for await(const c of req)chunks.push(c);const body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
 if(path===`/api/agent/${sid}/events`){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});res.write(`data: ${JSON.stringify({type:'connected',sessionId:sid})}\n\n`);streams.add(res);res.on('close',()=>streams.delete(res));return}
 if(path.endsWith('/events')){res.writeHead(204);res.end();return}
 if(path==='/api/engines')return json({engines:['omp','pi','claude','codex'].map(engine=>({engine,installed:true}))});
 if(path==='/api/home')return json({home:'/synthetic'});
 if(path==='/api/cwd/validate'||path==='/api/default-cwd')return json({success:true,cwd});
 if(path==='/api/sessions')return json({sessions:[info()],runningSessionIds:busy?[sid]:[]});
 if(path===`/api/sessions/${sid}`)return json({sessionId:sid,info:info(),filePath:'/synthetic/history.jsonl',tree:[],leafId:'a',context:context()});
 if(path===`/api/sessions/${sid}/context`)return json({context:context()});
 if(path===`/api/sessions/${sid}/state`)return json({running:true,state:state()});
 if(path==='/api/agent/running')return json({runningSessionIds:busy?[sid]:[]});
 if(path==='/api/models')return json({models:{'test:test-model':modelName},modelList:[{...model,name:modelName,contextWindow:768000}],defaultModel:null,thinkingLevels:{},thinkingLevelMaps:{},thinkingLevelPins:{}});
 if(path==='/api/project-trust')return json({requiresTrust:false,trusted:false});
 if(path==='/api/worktrees')return json({isGit:false,isTopLevel:false,projectRoot:cwd,worktrees:[]});
 if(path===`/api/agent/${sid}`){
  if(req.method==='GET')return json({running:true,state:state()});
  if(body.type==='get_state')return json({success:true,data:state()});
  if(body.type==='get_commands')return json({success:true,data:{commands:[]}});
  if(body.type==='get_messages')return json({success:true,data:{messages}});
  if(body.type==='abort'){abortCount++;busy=false;json({success:true,data:null});emit({type:'agent_end'});emit({type:'prompt_done'});emit({type:'agent_settled'});return}
  if(['prompt','steer','follow_up'].includes(body.type)){sendCount++;return json({success:true,data:null})}
  return json({success:true,data:null});
 }
 return json({files:[],entries:[],directories:[]});
});await new Promise(r=>proxy.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${proxy.address().port}`;
const profile=await mkdtemp(join(root,'browser-')),chrome=spawn('/usr/bin/google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ws,n=0,port;const pending=new Map();
function call(method,params={}){return new Promise((resolve,reject)=>{const id=++n,t=setTimeout(()=>reject(Error(method+' timeout')),15000);pending.set(id,{resolve:r=>{clearTimeout(t);resolve(r)},reject:e=>{clearTimeout(t);reject(e)}});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value}
async function wait(expression,label){for(let i=0;i<150;i++){if(await evaluate(expression))return;await sleep(100)}throw Error('UI timeout '+label)}
function check(ok,label,data){if(!ok)violations.push({case:results.at(-1)?.name,label,data})}
const visibleSelector=`button[data-composer-stop],button[title="停止 Agent"],button[title="Stop Agent"]`;
const engineSelector='select[data-chat-engine],select[aria-label="聊天引擎"],select[aria-label="Chat engine"]';
async function touch(selector){
 const p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
 assert.ok(p,selector);await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[p]});await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
}
async function escape(){await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});await sleep(50)}
async function bounded(selector,height,label){const r=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,height:r.height}})()`);check(r&&r.height>0&&r.x>=0&&r.y>=0&&r.right<=innerWidthForCheck+1&&r.bottom<=height+1,label,r)}
let innerWidthForCheck=0;
try{
 for(let i=0;i<100;i++){try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];break}catch{await sleep(100)}}
 const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
 ws.onmessage=({data})=>{const m=JSON.parse(data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text)};
 await call('Runtime.enable');await call('Page.enable');await call('Emulation.setTouchEmulationEnabled',{enabled:true});
 const protocol=await(await fetch(`http://127.0.0.1:${port}/json/protocol`)).json();
 const emulation=protocol.domains.find(d=>d.domain==='Emulation');
 const safeSupported=emulation.commands.some(c=>c.name==='setSafeAreaInsetsOverride');
 await writeFile(join(root,'safe-area-protocol.json'),JSON.stringify({command:emulation.commands.find(c=>c.name==='setSafeAreaInsetsOverride'),type:emulation.types.find(t=>t.id==='SafeAreaInsets')},null,2));
 await call('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('pi-locale','zh-CN');localStorage.setItem('omp-theme','dark');localStorage.setItem('omp-web:new-chat-engine','pi');
 const viewport=new EventTarget();Object.defineProperties(viewport,{height:{get:()=>window.__keyboardHeight||innerHeight},width:{get:()=>innerWidth},scale:{get:()=>1},offsetTop:{get:()=>0},offsetLeft:{get:()=>0}});Object.defineProperty(window,'visualViewport',{get:()=>viewport,configurable:true});window.__setKeyboard=h=>{window.__keyboardHeight=h;viewport.dispatchEvent(new Event('resize'))};`});
 const insets=safeSupported?[{name:'390-browser-inset44',width:390,height:844,busy:true,keyboard:400,safe:44},{name:'390-safe-inset-fixture',width:390,height:844,busy:true,keyboard:400,safe:44,insetFixture:true}]:[];
 const cases=process.argv.includes('--probe')?[
  {name:'390-browser-idle',width:390,height:844,busy:false,safe:0},
  {name:'390-keyboard-running',width:390,height:844,busy:true,keyboard:400,safe:0},...insets,
 ]:[
  ...[320,360,390,430].flatMap(width=>[{name:`${width}-idle`,width,height:844,busy:false,safe:0},{name:`${width}-keyboard`,width,height:844,busy:true,keyboard:400,safe:0}]),
  {name:'390-keyboard-blur-transition',width:390,height:844,busy:true,keyboard:400,safe:0,blurDuringClose:true},
  {name:'390-android-resized',width:390,height:400,busy:true,safe:0},
  {name:'844-landscape-keyboard',width:844,height:390,busy:true,keyboard:270,safe:0},
  {name:'390-english-light',width:390,height:844,busy:true,keyboard:400,safe:0,lang:'en',theme:'light'},...insets,
 ];
 for(const c of cases){
  busy=c.busy;innerWidthForCheck=c.width;modelName=c.width===320?'GPT-6 Astra — unusually long model name':'GPT-6 Astra';
  await call('Emulation.setDeviceMetricsOverride',{width:c.width,height:c.height,deviceScaleFactor:1,mobile:true});
  if(safeSupported)await call('Emulation.setSafeAreaInsetsOverride',{insets:{top:c.safe,bottom:0,left:0,right:0}});
  // CDP here cannot override display-mode. Unit tests cover that CSS condition;
  // the explicit inset fixture verifies its geometry, not a real installed PWA.
  await call('Emulation.setEmulatedMedia',{features:[]});
  const init=await call('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('pi-locale',${JSON.stringify(c.lang||'zh-CN')});localStorage.setItem('omp-theme',${JSON.stringify(c.theme||'dark')});`});
  await call('Page.navigate',{url:base+'/?session='+encodeURIComponent(sid)});await wait(`!!document.querySelector('textarea')&&!!document.querySelector(${JSON.stringify(engineSelector)})`,'chat');await sleep(250);
  await evaluate(`(()=>{const t=document.querySelector('textarea');t.focus();t.select()})()`);
  await call('Input.insertText',{text:'移动端输入区应占满整行，操作按钮不能挤压文字。停止按钮应始终可点击。'});
  await evaluate(`window.__setKeyboard(${c.keyboard||0});${c.insetFixture ? `document.documentElement.style.setProperty('--app-top-inset','${c.safe}px');` : ''}`);await sleep(200);
  if(c.blurDuringClose){await evaluate(`document.querySelector('button[aria-label="Choose theme"]').focus();window.__setKeyboard(420)`);await sleep(100)}
  const m=await evaluate(`(()=>{
   const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,centerY:r.y+r.height/2}};
   const e=document.querySelector(${JSON.stringify(engineSelector)}),bar=e.closest('[data-chat-topbar]')||e.parentElement;
   const stop=document.querySelector(${JSON.stringify(visibleSelector)}),s=rect(stop),hit=s&&document.elementFromPoint(s.x+s.width/2,s.y+s.height/2);
   const sidebar=document.querySelector('button[aria-label="显示侧边栏"]')||document.querySelector('button[aria-label="隐藏侧边栏"]')||bar.querySelector('button');
   const primary=[sidebar,e,document.querySelector('button[aria-label="Choose theme"]'),document.querySelector('button[aria-label="Switch language"]')].map(rect);
   const barRect=bar.getBoundingClientRect();
   const headerControls=[...bar.querySelectorAll('button,select'),document.querySelector('button[aria-controls="file-panel"]')].filter(Boolean).map(rect).filter(r=>r.width>0&&r.height>0&&r.y>=barRect.y-1&&r.bottom<=barRect.bottom+1);
   const area=document.querySelector('textarea'),box=area.closest('.sf-chat-input-box');
   const actions=[...document.querySelectorAll('[data-composer-actions] button')].map(rect);
   const more=document.querySelector('button[aria-label="更多控件"],button[aria-label="More controls"]'),attach=document.querySelector('[data-composer-attach],.sf-chat-input-wrap button[aria-label^="添加任意"]');
   const modelButton=document.querySelector('.sf-chat-input-wrap button[title="Change model"]');
   const scan=(rules,guard=false)=>[...rules].some(r=>{const g=guard||Boolean(r.conditionText?.includes('display-mode')&&r.conditionText?.includes('standalone'));if(g&&r.style?.getPropertyValue('--app-top-inset').includes('env(safe-area-inset-top'))return true;try{return r.cssRules&&scan(r.cssRules,g)}catch{return false}});
   const pwaRuleLoaded=[...document.styleSheets].some(sheet=>{try{return scan(sheet.cssRules)}catch{return false}});
   const viewport=visualViewport.height,probe=document.createElement('div');probe.style.paddingTop='env(safe-area-inset-top)';document.body.append(probe);const safe=getComputedStyle(probe).paddingTop;probe.remove();
   return {bar:rect(bar),barStyle:{paddingTop:getComputedStyle(bar).paddingTop,alignContent:getComputedStyle(bar).alignContent,flexWrap:getComputedStyle(bar).flexWrap},primary,headerControls,pwaRuleLoaded,modelButton:rect(modelButton),textarea:rect(area),box:rect(box),stop:s,stopVisible:!!stop&&s.width>0&&s.height>0&&s.y>=0&&s.bottom<=viewport+1&&!!hit&&(hit===stop||stop.contains(hit)),actions,more:rect(more),attach:rect(attach),viewport,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,safeArea:safe,standalone:matchMedia('(display-mode: standalone)').matches};
  })()`);
  results.push({name:c.name,...m});
  const inset=c.insetFixture?c.safe:0;
  if(c.insetFixture)check(m.primary.every(r=>r&&r.y-m.bar.y>=c.safe-1),'inset fixture retains notch protection',m.primary);
  if(c.width<=640){
   check(m.bar.height<=52+inset,'compact header height',m.bar);
   check(m.primary.every(r=>r&&r.y-m.bar.y-inset<=8),'no blank strip above controls',m.primary);
   check(Math.max(...m.headerControls.map(r=>r.centerY))-Math.min(...m.headerControls.map(r=>r.centerY))<=2,'all topbar controls share one centerline',m.headerControls);
   check(m.textarea.width>=m.box.width*.88,'editor occupies full input width',{text:m.textarea.width,box:m.box.width});
   check(m.actions.length>0&&m.actions.every(r=>r.y>=m.textarea.bottom),'actions below, not beside, editor',m.actions);
   if(m.actions.length)check([...m.actions,m.more,m.attach,m.modelButton].every(r=>r&&Math.abs(r.centerY-m.actions[0].centerY)<=2),'composer buttons align',m);
  }
  check(m.scrollWidth<=m.width+1,'no horizontal page overflow',m.scrollWidth);
  check(m.pwaRuleLoaded,'compiled stylesheet retains standalone/fullscreen safe-area rule',m.pwaRuleLoaded);
  await call('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:c.width,height:m.viewport,scale:1}}).then(r=>writeFile(join(root,c.name+'.png'),Buffer.from(r.data,'base64')));
  if(c.width<=640&&(c.width===320||c.name==='390-keyboard'||c.lang==='en')){
   const before=abortCount;
   await touch('button[aria-label="Choose theme"]');await wait(`!!document.querySelector('[role=listbox][aria-label="Select theme"]')`,'theme menu');await bounded('[role=listbox][aria-label="Select theme"]',m.viewport,'theme menu stays in viewport');await escape();await wait(`!document.querySelector('[role=listbox][aria-label="Select theme"]')`,'theme closes');
   await touch('button[aria-label="Switch language"]');await wait(`!!document.querySelector('[role=listbox][aria-label="Select language"]')`,'language menu');await bounded('[role=listbox][aria-label="Select language"]',m.viewport,'language menu stays in viewport');await escape();await wait(`!document.querySelector('[role=listbox][aria-label="Select language"]')`,'language closes');
   const moreExists=await evaluate(`!!document.querySelector('[data-mobile-toolbar-trigger]')`);check(moreExists,'secondary actions retained in menu',moreExists);
   if(moreExists){
    await touch('[data-mobile-toolbar-trigger]');await wait(`!!document.querySelector('[data-mobile-toolbar-menu]')`,'toolbar menu');await bounded('[data-mobile-toolbar-menu]',m.viewport,'toolbar menu stays in viewport');
    check(await evaluate(`document.querySelector('[data-toolbar-action="session"]')?.textContent.includes('768k')`),'context capacity remains accessible');
    await touch('[data-toolbar-action="session"]');await wait(`!!document.querySelector('.session-info-popover')`,'session panel');await bounded('[data-top-panel]',m.viewport,'session panel stays in viewport');await escape();await wait(`!document.querySelector('[data-top-panel]')`,'session panel closes');
    await touch('[data-mobile-toolbar-trigger]');await wait(`!!document.querySelector('[data-toolbar-action="system"]')`,'system action');await touch('[data-toolbar-action="system"]');
    await wait(`document.querySelector('[data-top-panel]')?.textContent.includes('SYNTHETIC_SYSTEM_PROMPT')`,'system prompt retained');await bounded('[data-top-panel]',m.viewport,'system panel stays in viewport');await escape();await wait(`!document.querySelector('[data-top-panel]')`,'system panel closes');
   }
   await touch('button[aria-label="更多控件"],button[aria-label="More controls"]');await wait(`document.querySelector('[data-composer-menu]')?.getBoundingClientRect().height>0`,'composer menu');await bounded('[data-composer-menu]',m.viewport,'composer menu stays in viewport');
   if(c.busy)check(await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(visibleSelector)});const r=e.getBoundingClientRect();const h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return h===e||e.contains(h)})()`),'composer menu never covers Stop');
   await touch('button[aria-label="收起控件"],button[aria-label="Collapse controls"]');await wait(`document.querySelector('[data-composer-menu]')?.getBoundingClientRect().height===0`,'composer menu closes');
   check(abortCount===before,'closing menus never aborts the agent',abortCount-before);
  }
  if(c.busy){
   check(m.stopVisible,'Stop directly visible and hit-testable with keyboard',m.stop);
   if(m.stopVisible){const before=abortCount;await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:m.stop.x+m.stop.width/2,y:m.stop.centerY}]});await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await wait(`!!document.querySelector('.sf-send-btn')`,'Stop settles');check(abortCount===before+1,'Stop touch submits once',abortCount-before)}
  }
  await evaluate(`window.__setKeyboard(0)`);await sleep(100);
  await bounded('.sf-chat-input-wrap',c.height,'composer remains visible after keyboard closes');
  if(await evaluate(`!!document.querySelector('.sf-send-btn')`)){
   const before=sendCount;await touch('.sf-send-btn');for(let i=0;i<50&&sendCount===before;i++)await sleep(20);
   check(sendCount===before+1,'Send touch submits once after keyboard closes',sendCount-before);
  }
  await call('Page.removeScriptToEvaluateOnNewDocument',{identifier:init.identifier});
 }
 assert.deepEqual(errors,[]);
 await writeFile(join(root,'result.json'),JSON.stringify({passed:!violations.length,results,violations,safeAreaOverrideSupported:safeSupported,standaloneCoverage:'CSS condition verified; geometry uses an explicit inset fixture, not a real installed PWA',realModelRequests:0},null,2));
 console.log(JSON.stringify({passed:!violations.length,reportDirectory:root,violations},null,2));
 if(violations.length)process.exitCode=1;
}catch(error){await writeFile(join(root,'failure.json'),JSON.stringify({error:String(error),results,violations,errors},null,2));console.error(root);throw error}
finally{ws?.close();chrome.kill('SIGTERM');for(const r of streams)r.end();proxy.closeAllConnections();await new Promise(r=>proxy.close(r));await new Promise(r=>chrome.exitCode!==null?r():chrome.once('exit',r));await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200})}
