import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createJiti} from 'jiti';
import {fileURLToPath} from 'node:url';
import {useTestWebLogin} from './web-auth-test-helper.mjs';
const jiti=createJiti(import.meta.url,{alias:{'@':fileURLToPath(new URL('..',import.meta.url))}});
const {readSessionSnapshot}=await jiti.import('./session-file-cache.ts');
const {cacheSessionPath}=await jiti.import('./session-reader.ts');
const {GET}=await jiti.import('../app/api/sessions/[id]/route.ts');
const {GET:messageGET}=await jiti.import('../app/api/sessions/[id]/entries/[entryId]/message/route.ts');
const {createHistoryClientCache,historyUrl}=await jiti.import('./history-client-cache.ts');

let cookie='';
async function fixture(t,count=180){
 cookie=(await useTestWebLogin(t)).cookie;
 const dir=await mkdtemp(join(tmpdir(),'history-fixture-')),id=randomUUID(),path=join(dir,id+'.jsonl');t.after(()=>rm(dir,{recursive:true,force:true}));
 const entries=[{type:'session',id,cwd:dir,version:3,timestamp:'2026-01-01T00:00:00Z'}];
 for(let i=0;i<count;i++)entries.push({type:'message',id:'e'+i,parentId:i?'e'+(i-1):null,timestamp:'2026-01-01T00:00:00Z',message:{role:i%2?'assistant':'user',content:[{type:'text',text:'synthetic '+i}],...(i%2?{model:'m',provider:'synthetic',usage:{input:10,output:2}}:{})}});
 await writeFile(path,entries.map(e=>JSON.stringify(e)).join('\n')+'\n');cacheSessionPath(id,path);return {dir,id,path,entries};
}
const request=(id,query='',headers={})=>new Request('http://localhost'+historyUrl(id)+(query?'&'+query:''),{headers:{host:'localhost',cookie,...headers}});

test('session snapshots reuse unchanged parses and invalidate on append or file replacement',async t=>{
 const f=await fixture(t);const first=readSessionSnapshot(f.path);assert.equal(readSessionSnapshot(f.path),first);
 await appendFile(f.path,JSON.stringify({type:'session_info',id:'title',parentId:'e179',name:'new'})+'\n');assert.notEqual(readSessionSnapshot(f.path),first);
 await rm(f.path);await writeFile(f.path,JSON.stringify(f.entries[0])+'\n');assert.equal(readSessionSnapshot(f.path).entries.length,1);
});

test('history pages keep entry IDs and totals aligned; matching ETags return zero body',async t=>{
 const f=await fixture(t),context={params:Promise.resolve({id:f.id})};const response=await GET(request(f.id),context),data=await response.json();
 assert.equal(data.context.messages.length,60);assert.equal(data.context.entryIds[0],'e120');assert.equal(data.page.total,180);assert.equal(data.page.prefix.totalMessages,120);assert.equal(data.page.prefix.tokens.input,600);
 const tag=response.headers.get('etag');assert.ok(tag);assert.equal(response.headers.get('cache-control'),'private, no-store');
 const unchanged=await GET(request(f.id,'',{'If-None-Match':tag}),context);assert.equal(unchanged.status,304);assert.equal(await unchanged.text(),'');
 const earlier=await (await GET(request(f.id,`before=${data.page.before}&version=${data.page.version}&leafId=${data.leafId}`),context)).json();
 assert.equal(earlier.context.entryIds.at(-1),'e119');assert.equal(earlier.page.prefix.totalMessages,60);
 await appendFile(f.path,JSON.stringify({type:'session_info',id:'new-title',parentId:'e179',name:'new'})+'\n');
 assert.equal((await GET(request(f.id,`before=${data.page.before}&version=${data.page.version}`),context)).status,409);
 assert.equal((await GET(request(f.id,'',{'If-None-Match':tag}),context)).status,200);
});

test('large content is absent from initial messages/tree but available through the scoped lazy route',async t=>{
 const f=await fixture(t,2);f.entries[2].message.content=[{type:'text',text:'LARGE_MARKER_'+ 'x'.repeat(100000)}];await writeFile(f.path,f.entries.map(e=>JSON.stringify(e)).join('\n')+'\n');
 const data=await (await GET(request(f.id),{params:Promise.resolve({id:f.id})})).json();assert.equal(data.context.messages[1].historyDeferred,true);assert.ok(JSON.stringify(data).length<10000);
 const full=await messageGET(new Request('http://localhost/api/message',{headers:{host:'localhost',cookie}}),{params:Promise.resolve({id:f.id,entryId:'e1'})});assert.equal((await full.json()).message.content[0].text.length,100013);
 assert.equal((await messageGET(new Request('http://localhost/api/message',{headers:{host:'localhost',cookie}}),{params:Promise.resolve({id:f.id,entryId:'foreign'})})).status,404);
});

test('conditional history requests still require authentication and origin checks',async t=>{
 const f=await fixture(t),context={params:Promise.resolve({id:f.id})};const good=await GET(request(f.id),context);const tag=good.headers.get('etag');
 assert.equal(good.status,200);
 assert.equal((await GET(request(f.id,'',{cookie:'','If-None-Match':tag}),context)).status,401);
 assert.equal((await GET(request(f.id,'',{cookie:'omp_web_session=forged.value','If-None-Match':tag}),context)).status,401);
 assert.equal((await GET(request(f.id,'',{cookie:'',origin:'https://evil.invalid','If-None-Match':tag}),context)).status,403);
});

const dto=id=>({sessionId:id,filePath:'/fake',tree:[],leafId:'e',context:{messages:[],entryIds:[],thinkingLevel:'off',model:null}});
test('browser history coalesces loads, supports conditional responses and enforces LRU bounds',async()=>{
 let calls=0,now304=false,seenHeaders;
 const cache=createHistoryClientCache(async(_url,options)=>{calls++;seenHeaders=options.headers;return now304?new Response(null,{status:304}):Response.json(dto(decodeURIComponent(new URL(_url,'http://localhost').pathname.split('/').at(-1))),{headers:{etag:'"v1"'}})},10000,1);
 const url=historyUrl('a');const [a,b]=await Promise.all([cache.load(url),cache.load(url)]);assert.equal(a,b);assert.equal(calls,1);assert.equal(cache.peek(url),a);
 await new Promise(r=>setTimeout(r,320));now304=true;assert.equal(await cache.load(url),a);assert.equal(seenHeaders['If-None-Match'],'"v1"');
 now304=false;await cache.load(historyUrl('b'));assert.equal(cache.peek(url),undefined);
});
test('a title update invalidating a pending load never rejects the chat that awaits it',async()=>{
 // Real fetch rejects with "AbortError: signal is aborted without reason" when aborted.
 let finish;const cache=createHistoryClientCache((_url,options)=>new Promise((resolve,reject)=>{
  options?.signal?.addEventListener('abort',()=>reject(new DOMException('signal is aborted without reason','AbortError')));finish=resolve;
 }));
 const url=historyUrl('a'),work=cache.load(url);await new Promise(r=>setImmediate(r));
 cache.invalidate('a');finish(Response.json(dto('a')));
 assert.equal((await work).sessionId,'a');assert.equal(cache.peek(url),undefined);
});
test('invalidated or unauthorized requests cannot repopulate browser history',async()=>{
 let finish;const cache=createHistoryClientCache(()=>new Promise(r=>{finish=r}));const url=historyUrl('a'),work=cache.load(url);await new Promise(r=>setImmediate(r));cache.invalidate('a');finish(Response.json(dto('a')));await work;assert.equal(cache.peek(url),undefined);
 let denied=false;const other=createHistoryClientCache(async()=>denied?new Response('',{status:401}):Response.json(dto('a')));
 await other.load(url);await new Promise(r=>setTimeout(r,320));denied=true;await assert.rejects(other.load(url));assert.equal(other.peek(url),undefined);
});
