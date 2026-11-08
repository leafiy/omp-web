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
const {GET:turnGET}=await jiti.import('../app/api/sessions/[id]/entries/[entryId]/turn/route.ts');
const {createHistoryClientCache,historyUrl,fetchHistoryTurn}=await jiti.import('./history-client-cache.ts');
const {turnRanges,summarizeTurn,clipText}=await jiti.import('./history-turns.ts');

let cookie='';
async function fixture(t,count=180){
 cookie=(await useTestWebLogin(t)).cookie;
 const dir=await mkdtemp(join(tmpdir(),'history-fixture-')),id=randomUUID(),path=join(dir,id+'.jsonl');t.after(()=>rm(dir,{recursive:true,force:true}));
 const entries=[{type:'session',id,cwd:dir,version:3,timestamp:'2026-01-01T00:00:00Z'}];
 for(let i=0;i<count;i++)entries.push({type:'message',id:'e'+i,parentId:i?'e'+(i-1):null,timestamp:'2026-01-01T00:00:00Z',message:{role:i%2?'assistant':'user',content:[{type:'text',text:'synthetic '+i}],...(i%2?{model:'m',provider:'synthetic',usage:{input:10,output:2}}:{})}});
 await writeFile(path,entries.map(e=>JSON.stringify(e)).join('\n')+'\n');cacheSessionPath(id,path);return {dir,id,path,entries};
}
const request=(id,query='',headers={})=>new Request('http://localhost'+historyUrl(id)+(query?'&'+query:''),{headers:{host:'localhost',cookie,...headers}});
const turnRequest=(id,entryId,query='',headers={})=>turnGET(new Request(`http://localhost/api/sessions/${id}/entries/${entryId}/turn?deferThinking=1${query?'&'+query:''}`,{headers:{host:'localhost',cookie,...headers}}),{params:Promise.resolve({id,entryId})});
async function rewrite(f){await writeFile(f.path,f.entries.map(e=>JSON.stringify(e)).join('\n')+'\n');}

test('session snapshots reuse unchanged parses and invalidate on append or file replacement',async t=>{
 const f=await fixture(t);const first=readSessionSnapshot(f.path);assert.equal(readSessionSnapshot(f.path),first);
 await appendFile(f.path,JSON.stringify({type:'session_info',id:'title',parentId:'e179',name:'new'})+'\n');assert.notEqual(readSessionSnapshot(f.path),first);
 await rm(f.path);await writeFile(f.path,JSON.stringify(f.entries[0])+'\n');assert.equal(readSessionSnapshot(f.path).entries.length,1);
});

test('history windows hold whole recent turns, outline older turns, and keep totals aligned',async t=>{
 const f=await fixture(t),context={params:Promise.resolve({id:f.id})};const response=await GET(request(f.id),context),data=await response.json();
 // 180 alternating messages = 90 prompt turns; the newest 10 arrive whole.
 assert.equal(data.context.messages.length,20);assert.equal(data.context.entryIds[0],'e160');assert.equal(data.page.before,'e160');
 assert.equal(data.page.total,180);assert.equal(data.page.prefix.totalMessages,160);assert.equal(data.page.prefix.tokens.input,800);
 assert.equal(data.page.turns.length,80);
 assert.deepEqual(data.page.turns[0],{id:'e0',lastId:'e1',count:2,kind:'user',text:'synthetic 0',images:0,toolCalls:0,endsWithAssistant:true});
 assert.equal(data.page.turns.at(-1).id,'e158');
 const tag=response.headers.get('etag');assert.ok(tag);assert.equal(response.headers.get('cache-control'),'private, no-store');
 const unchanged=await GET(request(f.id,'',{'If-None-Match':tag}),context);assert.equal(unchanged.status,304);assert.equal(await unchanged.text(),'');
 const turn=await (await turnRequest(f.id,'e100',`leafId=${data.leafId}`)).json();
 assert.deepEqual(turn.entryIds,['e100','e101']);assert.equal(turn.messages[1].content[0].text,'synthetic 101');assert.equal(turn.turn.id,'e100');
 await appendFile(f.path,JSON.stringify({type:'session_info',id:'new-title',parentId:'e179',name:'new'})+'\n');
 assert.equal((await GET(request(f.id,`version=${data.page.version}`),context)).status,409);
 assert.equal((await GET(request(f.id,'',{'If-None-Match':tag}),context)).status,200);
 // Older turns are immutable along the branch, so the outline's leaf still resolves them after an append.
 assert.equal((await turnRequest(f.id,'e100',`leafId=${data.leafId}`)).status,200);
});

test('turns are never split: large content arrives whole in the window or through the turn route',async t=>{
 const f=await fixture(t,2);f.entries[2].message.content=[{type:'text',text:'LARGE_MARKER_'+'x'.repeat(100000)}];await rewrite(f);
 const newest=await (await GET(request(f.id),{params:Promise.resolve({id:f.id})})).json();
 assert.equal(newest.context.messages[1].content[0].text.length,100013);assert.equal(newest.page.turns.length,0);assert.equal(newest.page.before,null);

 const g=await fixture(t,40);g.entries[2].message.content=[{type:'text',text:'LARGE_MARKER_'+'x'.repeat(100000)}];await rewrite(g);
 const data=await (await GET(request(g.id),{params:Promise.resolve({id:g.id})})).json();
 assert.equal(data.context.entryIds[0],'e20');assert.ok(JSON.stringify(data).length<20000);assert.equal(data.page.turns[0].text,'synthetic 0');
 const full=await (await turnRequest(g.id,'e0',`leafId=${data.leafId}`)).json();assert.equal(full.messages[1].content[0].text.length,100013);
 // Only turn starts on the selected branch resolve.
 assert.equal((await turnRequest(g.id,'e1',`leafId=${data.leafId}`)).status,409);
 assert.equal((await turnRequest(g.id,'foreign',`leafId=${data.leafId}`)).status,409);
 assert.equal((await turnRequest(g.id,'e30',`leafId=e20`)).status,409);
});

test('the window budget keeps at least the newest turn and stops before an oversized older one',async t=>{
 const f=await fixture(t,6);f.entries[6].message.content=[{type:'text',text:'y'.repeat(1_200_000)}];await rewrite(f);
 const data=await (await GET(request(f.id),{params:Promise.resolve({id:f.id})})).json();
 assert.deepEqual(data.context.entryIds,['e4','e5']);assert.deepEqual(data.page.turns.map(turn=>turn.id),['e0','e2']);
 const g=await fixture(t,6);g.entries[4].message.content=[{type:'text',text:'z'.repeat(1_200_000)}];await rewrite(g);
 const older=await (await GET(request(g.id),{params:Promise.resolve({id:g.id})})).json();
 assert.deepEqual(older.context.entryIds,['e4','e5']);assert.deepEqual(older.page.turns.map(turn=>turn.id),['e0','e2']);
});

test('turn segmentation covers every message once; compaction anchors and preambles get their own turn',()=>{
 const messages=[
  {role:'custom',customType:'branch_summary',content:'s',display:true},
  {role:'assistant',content:[{type:'toolCall',toolCallId:'a',toolName:'read',input:{}}],model:'m',provider:'p'},
  {role:'user',content:[{type:'text',text:'  look\n at   this '},{type:'image',source:{type:'base64',media_type:'image/png',data:'AA=='}}],timestamp:5},
  {role:'assistant',content:[{type:'text',text:'ok'}],model:'m',provider:'p'},
  {role:'custom',customType:'compaction',content:'summary',display:true},
  {role:'toolResult',toolCallId:'b',content:[]},
 ],ids=['p0','p1','u0','a0','c0','r0'];
 assert.deepEqual(turnRanges(messages),[{start:0,end:2},{start:2,end:4},{start:4,end:6}]);
 assert.deepEqual(turnRanges([]),[]);
 assert.deepEqual(summarizeTurn(messages,ids,0,2),{id:'p0',lastId:'p1',count:2,kind:'preamble',text:'',images:0,toolCalls:1,endsWithAssistant:true});
 assert.deepEqual(summarizeTurn(messages,ids,2,4),{id:'u0',lastId:'a0',count:2,kind:'user',text:'look at this',images:1,toolCalls:0,timestamp:5,endsWithAssistant:true});
 assert.equal(summarizeTurn(messages,ids,4,6).kind,'compaction');assert.equal(summarizeTurn(messages,ids,4,6).endsWithAssistant,false);
 assert.equal(clipText('ab\u{1F600}cd',3),'ab…');assert.equal(clipText('abc',3),'abc');
});

test('the browser rejects a turn response that does not match its outline entry',async()=>{
 const turn={id:'e0',lastId:'e1',count:2,kind:'user',text:'',images:0,toolCalls:0,endsWithAssistant:true};
 const reply=body=>async()=>Response.json(body);
 const good={sessionId:'s',leafId:'e1',turn,messages:[{role:'user',content:'a'},{role:'assistant',content:[]}],entryIds:['e0','e1']};
 assert.deepEqual((await fetchHistoryTurn('s',turn,'e1',reply(good))).entryIds,['e0','e1']);
 await assert.rejects(fetchHistoryTurn('s',turn,'e1',reply({...good,entryIds:['e0','e9']})),{status:409});
 await assert.rejects(fetchHistoryTurn('s',turn,'e1',reply({...good,sessionId:'other'})),{status:409});
 await assert.rejects(fetchHistoryTurn('s',turn,'e1',async()=>new Response('',{status:503})),{status:503});
});

test('conditional history requests still require authentication and origin checks',async t=>{
 const f=await fixture(t),context={params:Promise.resolve({id:f.id})};const good=await GET(request(f.id),context);const tag=good.headers.get('etag');
 assert.equal(good.status,200);
 assert.equal((await GET(request(f.id,'',{cookie:'','If-None-Match':tag}),context)).status,401);
 assert.equal((await GET(request(f.id,'',{cookie:'omp_web_session=forged.value','If-None-Match':tag}),context)).status,401);
 assert.equal((await GET(request(f.id,'',{cookie:'',origin:'https://evil.invalid','If-None-Match':tag}),context)).status,403);
 assert.equal((await turnRequest(f.id,'e0','',{cookie:''})).status,401);
 assert.equal((await turnRequest(f.id,'e0','',{origin:'https://evil.invalid'})).status,403);
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
