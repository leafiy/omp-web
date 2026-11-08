import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, chmod, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { loadWebPassword } from '../bin/web-password.js';
import { loadWebCredentials, verifyWebLogin, createSessionToken, setWebCredentials } from '../bin/web-credentials.js';
import { useNoWebLogin, useTestWebLogin } from './web-auth-test-helper.mjs';
const jiti=createJiti(import.meta.url,{alias:{'@':fileURLToPath(new URL('..',import.meta.url))}});
const {discoverAgent}=await jiti.import('./agent-executable.ts');
const {nativeAgentEnvironment}=await jiti.import('./native-agent-environment.ts');
const {proxy}=await jiti.import('../proxy.ts');
const {GET:runningEvents}=await jiti.import('../app/api/agent/running/events/route.ts');
const {NextRequest}=await import('next/server.js');
async function temp(t){const root=await mkdtemp(join(tmpdir(),'native-host-'));t.after(()=>rm(root,{recursive:true,force:true}));return root}
async function executable(path){await mkdir(join(path,'..'),{recursive:true});await writeFile(path,'#!/bin/sh\nexit 97\n',{mode:0o755})}

test('all four CLI paths are discovered in a user bin absent from service PATH',async t=>{
 const home=await temp(t);for(const tool of ['omp','pi','claude','codex'])await executable(join(home,'.local/bin',tool));
 for(const tool of ['omp','pi','claude','codex']){
  const found=discoverAgent(tool,{home,env:{PATH:'/missing'},appRoot:join(home,'web'),nodePath:'/missing/node',systemDirs:[]});
  assert.equal(found.executable,join(home,'.local/bin',tool));assert.equal(found.installed,true);
 }
});
test('PATH wins over common locations; explicit broken selections never fall back',async t=>{
 const home=await temp(t);await executable(join(home,'path/pi'));await executable(join(home,'.local/bin/pi'));
 const base={home,appRoot:join(home,'web'),nodePath:'/missing/node',systemDirs:[]};
 assert.equal(discoverAgent('pi',{...base,env:{PATH:join(home,'path')}}).executable,join(home,'path/pi'));
 const missing=discoverAgent('pi',{...base,env:{PATH:join(home,'path'),OMP_WEB_PI_EXECUTABLE:'/missing/pi'}});
 assert.equal(missing.installed,false);assert.match(missing.error,/no fallback/);
});
test('the bundled Pi dependency and relative PATH entries cannot become native agents',async t=>{
 const home=await temp(t),appRoot=join(home,'web');await executable(join(appRoot,'node_modules/old-pi/pi'));
 await mkdir(join(appRoot,'node_modules/.bin'),{recursive:true});await symlink('../old-pi/pi',join(appRoot,'node_modules/.bin/pi'));
 const d=discoverAgent('pi',{home,appRoot,nodePath:'/missing/node',systemDirs:[],env:{PATH:'.:'+join(appRoot,'node_modules/.bin')}});
 assert.equal(d.installed,false);
});
test('NVM locations are searched in numeric version order',async t=>{
 const home=await temp(t);await executable(join(home,'.nvm/versions/node/v9.0.0/bin/pi'));await executable(join(home,'.nvm/versions/node/v22.0.0/bin/pi'));
 assert.equal(discoverAgent('pi',{home,appRoot:join(home,'web'),nodePath:'/missing/node',systemDirs:[],env:{PATH:'/missing'}}).executable,join(home,'.nvm/versions/node/v22.0.0/bin/pi'));
});
test('the web password file is private, nonempty and never falls back when broken',async t=>{
 const root=await temp(t),file=join(root,'password');await writeFile(file,'test-only-password\n',{mode:0o600});
 assert.equal(loadWebPassword({PI_WEB_PASSWORD_FILE:file}),'test-only-password');
 assert.throws(()=>loadWebPassword({PI_WEB_PASSWORD_FILE:file,PI_WEB_PASSWORD:'other'}),/not both/);
 await chmod(file,0o644);assert.throws(()=>loadWebPassword({PI_WEB_PASSWORD_FILE:file}),/private regular/);
 await chmod(file,0o600);await writeFile(file,'');assert.throws(()=>loadWebPassword({PI_WEB_PASSWORD_FILE:file}),/private regular/);
 assert.throws(()=>loadWebPassword({PI_WEB_PASSWORD_FILE:join(root,'missing')}),/private regular/);
 assert.throws(()=>loadWebPassword({OMP_WEB_REQUIRE_PASSWORD:'1'}),/requires/);
});
test('password rotation invalidates the cache and symlinks are rejected',async t=>{
 const root=await temp(t),file=join(root,'password');await writeFile(file,'one',{mode:0o600});assert.equal(loadWebPassword({PI_WEB_PASSWORD_FILE:file}),'one');
 const next=join(root,'next');await writeFile(next,'two',{mode:0o600});await rename(next,file);assert.equal(loadWebPassword({PI_WEB_PASSWORD_FILE:file}),'two');
 await symlink(file,join(root,'link'));assert.throws(()=>loadWebPassword({PI_WEB_PASSWORD_FILE:join(root,'link')}),/private regular/);
});
test('the proxy requires a login session and never sends a Basic Auth challenge',async t=>{
 const {cookie}=await useTestWebLogin(t);
 const request=(headers={},path='/api/engines')=>new NextRequest('http://localhost'+path,{headers:{host:'localhost',...headers}});
 const denied=proxy(request());assert.equal(denied.status,401);assert.equal(denied.headers.get('www-authenticate'),null);assert.equal(denied.headers.get('x-omp-web-auth'),'required');
 assert.equal(proxy(request({authorization:'Basic '+Buffer.from('tester:test-only-password').toString('base64')})).status,401);
 assert.equal(proxy(request({cookie:'omp_web_session=forged.value'})).status,401);
 assert.equal(proxy(request({cookie})).status,200);
 // Absolute here; Next's middleware adapter relativizes same-host redirects.
 const page=proxy(request({},'/'));assert.equal(page.status,307);assert.equal(page.headers.get('location'),'http://localhost/login');assert.equal(page.headers.get('cache-control'),'no-store');
 assert.equal(proxy(request({cookie},'/')).status,200);
 for(const path of ['/api/web-auth/status','/api/web-auth/login'])assert.equal(proxy(request({},path)).status,200);
 for(const path of ['/api/web-auth/credentials','/api/web-auth/logout','/api/auth/login/events','/api/files/project/events','/api/sessions/events'])assert.equal(proxy(request({},path)).status,401);
 const abort=new AbortController();t.after(()=>abort.abort());
 const stream=await runningEvents(new Request('http://localhost/api/agent/running/events',{headers:{host:'localhost'},signal:abort.signal}));
 assert.equal(stream.status,401);
 assert.equal(proxy(request({cookie},'/api/auth/login/events')).status,409);
});
test('no configured credentials means no access at all',async t=>{
 await useNoWebLogin(t);
 assert.equal(loadWebCredentials(),undefined);
 assert.equal(proxy(new NextRequest('http://localhost/api/engines',{headers:{host:'localhost'}})).status,401);
 assert.equal(proxy(new NextRequest('http://localhost/',{headers:{host:'localhost'}})).status,307);
});
test('legacy password file still signs in until web credentials are saved',async t=>{
 await useNoWebLogin(t);
 const root=await temp(t),file=join(root,'password');await writeFile(file,'legacy-password',{mode:0o600});
 process.env.PI_WEB_PASSWORD_FILE=file;
 const legacy=loadWebCredentials();assert.equal(legacy.source,'legacy');assert.equal(legacy.username,'pi');
 assert.equal(await verifyWebLogin(legacy,'pi','legacy-password'),true);assert.equal(await verifyWebLogin(legacy,'pi','wrong'),false);assert.equal(await verifyWebLogin(legacy,'admin','legacy-password'),false);
 const request=cookie=>new NextRequest('http://localhost/api/engines',{headers:{host:'localhost',cookie}});
 const old='omp_web_session='+createSessionToken(legacy);assert.equal(proxy(request(old)).status,200);
 await setWebCredentials('admin','new-password-123');
 const stored=loadWebCredentials();assert.equal(stored.source,'file');assert.equal(stored.username,'admin');
 assert.equal(proxy(request(old)).status,401);
 assert.equal(await verifyWebLogin(stored,'admin','new-password-123'),true);assert.equal(await verifyWebLogin(stored,'admin','legacy-password'),false);
});
test('native environment preserves provider configuration but never inherits web secrets',()=>{
 const child=nativeAgentEnvironment({ANTHROPIC_BASE_URL:'https://native.example',OPENAI_API_KEY:'native-test',CLAUDE_CONFIG_DIR:'/native',PI_WEB_PASSWORD:'web',PI_WEB_PASSWORD_FILE:'/web/secret',OMP_WEB_CC_MODEL:'old-override',PI_SESSION_ID:'parent'});
 assert.equal(child.OPENAI_API_KEY,'native-test');assert.equal(child.CLAUDE_CONFIG_DIR,'/native');assert.equal(child.ANTHROPIC_BASE_URL,'https://native.example');
 assert.equal(child.PI_WEB_PASSWORD,undefined);assert.equal(child.PI_WEB_PASSWORD_FILE,undefined);assert.equal(child.OMP_WEB_CC_MODEL,undefined);assert.equal(child.PI_SESSION_ID,undefined);
});
