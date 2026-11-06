import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url,{alias:{'@':fileURLToPath(new URL('..',import.meta.url))}});
const {normalizeNativeSkills}=await jiti.import('./native-skills-data.ts');
const {createNativeSkillsService}=await jiti.import('./native-skills.ts');
const {createNativeSkillsHandler}=await jiti.import('./native-skills-http.ts');

test('OMP and Pi keep only explicitly marked native skills, not builtins or prompt extensions',()=>{
 for(const engine of ['omp','pi']){
  const report=normalizeNativeSkills(engine,'/project',{commands:[
   {name:'help',source:'builtin'},{name:'custom',source:'extension'},{name:'prompt',source:'prompt'},
   {name:'skill:review',source:'skill',description:'Review',sourceInfo:{path:'/native/skills/review/SKILL.md',secret:'not-returned'}},
  ]});
  assert.equal(report.items.length,1);assert.equal(report.items[0].invocation,'/skill:review');assert.equal(report.items[0].enabled,null);
  assert.ok(!JSON.stringify(report).includes('not-returned'));assert.equal(report.engine,engine);
 }
});
test('Claude excludes builtin collisions and labels the remaining mixed catalog honestly',()=>{
 const report=normalizeNativeSkills('claude','/p',{commands:[
  {name:'effort',builtin:true},{name:'effort',description:'shadowed skill'},{name:'plugin:review',description:'Review'},
  {name:'login',description:'custom login name'},
 ]});
 assert.deepEqual(report.items.map(s=>s.name),['login','plugin:review']);
 assert.equal(report.items[0].invocation,null);assert.equal(report.items[1].invocation,'/plugin:review');
 assert.ok(report.items.every(s=>s.kind==='command'&&s.enabled===null&&s.path===null));
});
test('Codex selects the exact project, preserves disabled states and never returns raw errors',()=>{
 const report=normalizeNativeSkills('codex','/p',{data:[
  {cwd:'/other',skills:[{name:'wrong'}],errors:[]},
  {cwd:'/p',skills:[{name:'review',description:'Review',enabled:false,path:'/native/review/SKILL.md'}],errors:[{path:'/secret',message:'private-native-diagnostic'}]},
 ]});
 assert.equal(report.status,'partial');assert.equal(report.items[0].enabled,false);assert.equal(report.items[0].invocation,null);
 assert.ok(!JSON.stringify(report).includes('private-native-diagnostic'));
 assert.throws(()=>normalizeNativeSkills('codex','/missing',{data:[]}));
 assert.throws(()=>normalizeNativeSkills('omp','/p',{}));
});
test('skill metadata caches isolate engine/project and coalesce reads without persistent sessions',async()=>{
 const opened=[],closed=[];let time=10000;
 const get=createNativeSkillsService({now:()=>time,installed:()=>true,open:(engine,cwd)=>{
  opened.push([engine,cwd]);return {read:async()=>({commands:[{name:engine+'-skill',source:'skill'}]}),destroy:()=>closed.push(engine)};
 }});
 const first=get('omp','/a');assert.equal(get('omp','/a',true),first);await first;
 await get('pi','/a');await get('omp','/b');assert.equal(opened.length,3);assert.equal(closed.length,3);
 await get('omp','/a',true);assert.equal(opened.length,3);
 time+=6000;await get('omp','/a',true);assert.equal(opened.length,4);
 assert.deepEqual(opened,[['omp','/a'],['pi','/a'],['omp','/b'],['omp','/a']]);
});
test('missing agents, native failure and timeout are explicit; every reader is destroyed',async()=>{
 let closed=0;
 const missing=createNativeSkillsService({installed:()=>false,open:()=>{throw Error('must not open')}});
 assert.equal((await missing('claude','/p')).status,'unavailable');
 const failed=createNativeSkillsService({installed:()=>true,open:()=>({read:async()=>{throw Error('secret-native-output')},destroy:()=>closed++})});
 const report=await failed('omp','/p');assert.equal(report.status,'error');assert.ok(!JSON.stringify(report).includes('secret-native-output'));
 const timed=createNativeSkillsService({installed:()=>true,timeoutMs:5,open:()=>({read:()=>new Promise(()=>{}),destroy:()=>closed++})});
 assert.equal((await timed('pi','/p')).status,'error');assert.equal(closed,2);
});
test('concurrent catalog reads are bounded across distinct projects',async()=>{
 const releases=[];let opened=0;
 const get=createNativeSkillsService({installed:()=>true,open:()=>{opened++;return {read:()=>new Promise(resolve=>releases.push(()=>resolve({commands:[]}))),destroy(){}}}});
 const active=Array.from({length:4},(_,i)=>get('omp','/p'+i));assert.equal((await get('omp','/another')).status,'unavailable');assert.equal(opened,4);
 releases.forEach(done=>done());await Promise.all(active);
});
test('native skills HTTP guards run before path checks or any agent startup',async t=>{
 const saved={PI_WEB_PASSWORD:process.env.PI_WEB_PASSWORD,PI_WEB_PASSWORD_FILE:process.env.PI_WEB_PASSWORD_FILE,OMP_WEB_REQUIRE_PASSWORD:process.env.OMP_WEB_REQUIRE_PASSWORD};
 process.env.PI_WEB_PASSWORD='test-skills-password';delete process.env.PI_WEB_PASSWORD_FILE;delete process.env.OMP_WEB_REQUIRE_PASSWORD;
 t.after(()=>{for(const[k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v}});
 let paths=0,reads=0;
 const GET=createNativeSkillsHandler({resolveCwd:async cwd=>{paths++;return cwd==='/allowed'?cwd:undefined},getSkills:async(engine,cwd)=>{reads++;return {engine,cwd,status:'ok',items:[]}}});
 const req=(query='engine=pi&cwd=/allowed',auth=true,origin='http://localhost',method='GET')=>new Request('http://localhost/api/native-skills?'+query,{method,headers:{host:'localhost',origin,...(auth?{authorization:'Basic '+Buffer.from('pi:test-skills-password').toString('base64')}:{})}});
 assert.equal((await GET(req(undefined,false))).status,401);assert.equal((await GET(req(undefined,true,'https://untrusted.invalid'))).status,403);assert.equal(paths,0);
 for(const query of ['engine=bad&cwd=/allowed','engine=pi&cwd=relative','cwd=/allowed','engine=pi&cwd=/allowed&command=prompt','engine=pi&engine=omp&cwd=/allowed'])assert.equal((await GET(req(query))).status,400);
 assert.equal((await GET(req(undefined,true,undefined,'POST'))).status,405);assert.equal(reads,0);
 assert.equal((await GET(req('engine=pi&cwd=/denied'))).status,403);assert.equal(reads,0);
 const response=await GET(req());assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).engine,'pi');assert.equal(reads,1);
});
test('the Skills entry is separate from Settings and works without a selected project',async()=>{
 const source=await readFile(new URL('../components/AppShell.tsx',import.meta.url),'utf8');
 const block=source.slice(source.indexOf('{skillsConfigOpen &&'),source.indexOf('{usageOpen &&'));
 assert.match(block,/<NativeSkillsPanel/);assert.doesNotMatch(block,/OmpNativeSettings|skillsConfigOpen && projectTrustCwd/);
 const reader=await readFile(new URL('./native-skills.ts',import.meta.url),'utf8');
 assert.match(reader,/catalogOnly: true/);assert.match(reader,/request\("skills\/list", \{ cwds: \[cwd\], forceReload: false \}\)/);
 assert.doesNotMatch(reader,/thread\/start|turn\/start|type: "prompt"|readFile|reloadSkills/);
});
