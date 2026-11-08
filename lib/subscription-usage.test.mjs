import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { useTestWebLogin } from './web-auth-test-helper.mjs';
const jiti=createJiti(import.meta.url,{alias:{'@':fileURLToPath(new URL('..',import.meta.url))}});
const {normalizeClaudeUsage,normalizeCodexUsage,normalizeSessionUsage,tokenCount}=await jiti.import('./usage-normalize.ts');
const {ClaudeCodeSession}=await jiti.import('./claude-code-session.ts');
const {CodexRpcClient}=await jiti.import('./codex-rpc-client.ts');
const {getSubscriptionUsage,buildTokenPeriods,parsePeriodQuery}=await jiti.import('./subscription-usage.ts');
const {GET}=await jiti.import('../app/api/usage/route.ts');
const account={account:{type:'chatgpt',planType:'plus',email:'private-test@example.invalid'}};

test('Claude weekly remaining is a percentage; empty probe tokens are not lifetime totals',()=>{
 const raw={subscription_type:'max',rate_limits_available:true,rate_limits:{seven_day:{utilization:37.5,resets_at:'2026-11-12T00:00:00Z'}},session:{model_usage:{}}};
 const report=normalizeClaudeUsage(raw,false);
 assert.equal(report.weekly[0].remainingPercent,62.5);assert.equal(report.totalTokens,null);assert.equal(report.tokenScope,null);
 assert.equal(normalizeClaudeUsage(raw,true).totalTokens,'0');assert.equal(normalizeClaudeUsage(raw,true).tokenScope,'session');
});
test('Claude session totals count native input/output/cache categories, not thinking twice',()=>{
 const report=normalizeClaudeUsage({session:{model_usage:{model:{inputTokens:10,outputTokens:20,cacheReadInputTokens:30,cacheCreationInputTokens:40,thinkingOutputTokens:19}}}},true);
 assert.equal(report.totalTokens,'100');assert.equal(report.tokenScope,'session');
 assert.equal(normalizeClaudeUsage({session:{model_usage:{model:{inputTokens:10}}}},true).totalTokens,null);
});
test('unknown or unavailable weekly usage never becomes zero consumption',()=>{
 assert.deepEqual(normalizeClaudeUsage({rate_limits:{seven_day:{utilization:null}}},false).weekly,[]);
 assert.deepEqual(normalizeClaudeUsage({rate_limits_available:false,rate_limits:{seven_day:{utilization:20}}},false).weekly,[]);
 assert.equal(normalizeCodexUsage(account,null,{summary:{lifetimeTokens:null}}).totalTokens,null);
});
test('new native Claude rows use their kind/group, and old reset times do not imply recovery',()=>{
 const report=normalizeClaudeUsage({rate_limits:{limits:[{kind:'weekly_all',group:'weekly',percent:100,resets_at:'2000-01-01T00:00:00Z'},{kind:'session',group:'session',percent:15,resets_at:null}]}},false);
 assert.equal(report.weekly.length,1);assert.equal(report.weekly[0].remainingPercent,0);
});
test('Codex weekly window must be seven days; legacy and multi-bucket data are not duplicated',()=>{
 const bucket={limitName:'Codex',primary:{usedPercent:80,windowDurationMins:300,resetsAt:null},secondary:{usedPercent:25,windowDurationMins:10080,resetsAt:1800000000}};
 const report=normalizeCodexUsage(account,{rateLimits:bucket,rateLimitsByLimitId:{codex:bucket},ordinaryUsageAllowed:false},{summary:{lifetimeTokens:1234567}});
 assert.equal(report.weekly.length,1);assert.equal(report.weekly[0].remainingPercent,75);assert.equal(report.totalTokens,'1234567');assert.equal(report.tokenScope,'account');
 assert.equal(report.ordinaryUsageAllowed,false);assert.ok(!JSON.stringify(report).includes('private-test@example'));
 assert.equal(normalizeCodexUsage(account,{rateLimits:{limitName:'weekly',primary:{usedPercent:20,windowDurationMins:null}}},{}).weekly.length,0);
});
test('Codex native daily buckets give local calendar periods; malformed or missing buckets stay unknown',()=>{
 const query={starts:[0,0,0],dates:['2026-11-08','2026-11-02','2026-11-01']},local={rows:[],pending:false,scannedAt:null};
 const report=normalizeCodexUsage(account,null,{summary:{lifetimeTokens:999},dailyUsageBuckets:[{startDate:'2026-11-08',tokens:5},{startDate:'2026-11-02T00:00:00Z',tokens:7},{startDate:'2026-10-31',tokens:100}]});
 assert.deepEqual(report.dailyTokens,[{date:'2026-10-31',tokens:'100'},{date:'2026-11-02',tokens:'7'},{date:'2026-11-08',tokens:'5'}]);
 const codex=buildTokenPeriods([report],local,query).rows.find(r=>r.engine==='codex');
 assert.deepEqual([codex.scope,codex.status,codex.day.total,codex.week.total,codex.month.total,codex.dataFrom],['account','ok','5','12','12',null]);
 const late=buildTokenPeriods([normalizeCodexUsage(account,null,{dailyUsageBuckets:[{startDate:'2026-11-05',tokens:3}]})],local,query).rows[0];
 assert.equal(late.dataFrom,'2026-11-05','a later first bucket is shown instead of implying a whole month');
 for(const usage of [{dailyUsageBuckets:[{startDate:'bad',tokens:1}]},{dailyUsageBuckets:[{startDate:'2026-11-08',tokens:-1}]},{dailyUsageBuckets:null},{}])
  assert.equal(normalizeCodexUsage(account,null,usage).dailyTokens,null);
 const unknown=buildTokenPeriods([normalizeCodexUsage(account,null,null)],local,query).rows[0];
 assert.deepEqual([unknown.status,unknown.day,unknown.week,unknown.month],['unavailable',null,null,null]);
});
test('local rows report totals with parts, stay pending before a complete pass, and omit absent stores',()=>{
 const query={starts:[0,0,0],dates:['2026-11-08','2026-11-02','2026-11-01']};
 const local={pending:true,scannedAt:'2026-11-08T00:00:00.000Z',rows:[{engine:'claude',complete:true,periods:[[1,2,3,4],[10,20,30,40],[100,200,300,400]]},{engine:'omp',complete:false,periods:[[9,9,9,9],[9,9,9,9],[9,9,9,9]]}]};
 const periods=buildTokenPeriods([],local,query);
 assert.deepEqual(periods.rows.map(r=>[r.engine,r.scope,r.status]),[['claude','local','ok'],['codex','account','unavailable'],['omp','local','pending']]);
 assert.deepEqual(periods.rows[0].day,{total:'10',input:'1',output:'2',cacheRead:'3',cacheWrite:'4'});
 assert.equal(periods.rows[0].month.total,'1000');assert.equal(periods.rows[2].day,null);
 assert.equal(periods.pending,true);assert.equal(periods.scannedAt,'2026-11-08T00:00:00.000Z');
});
test('period query accepts three recent instants and calendar dates only',()=>{
 const now=Date.parse('2026-11-08T12:00:00Z'),day=86400_000,dates='2026-11-08,2026-11-02,2026-11-01';
 assert.deepEqual(parsePeriodQuery(`${now-3600_000},${now-6*day},${now-31*day}`,dates,now),{starts:[now-3600_000,now-6*day,now-31*day],dates:['2026-11-08','2026-11-02','2026-11-01']});
 for(const [since,d] of [['1,2,3',dates],[`${now},${now}`,'2026-11-08,2026-11-02'],[`${now},${now},${now}`,'2026-11-08,2026-11-02,x'],[`${now},${now},${now-60*day}`,dates],[`${now},${now},1e12`,dates],[null,null]])
  assert.equal(parsePeriodQuery(since,d,now),null);
});
test('token totals preserve exact integers and distinguish explicit zero from missing',()=>{
 assert.equal(tokenCount(0),'0');assert.equal(tokenCount(undefined),null);assert.equal(tokenCount(-1),null);assert.equal(tokenCount(Number.MAX_SAFE_INTEGER+1),null);
 assert.equal(tokenCount('12345678901234567890'),'12345678901234567890');assert.equal(tokenCount('secret-token'),null);
 assert.equal(normalizeSessionUsage('pi',{tokens:{total:42}}).totalTokens,'42');
 assert.equal(normalizeSessionUsage('omp',{contextUsage:{tokens:42}}).totalTokens,null);
});
test('collector uses native metadata only, shares concurrent reads, and ignores bogus session cache keys',async t=>{
 const root=await mkdtemp(join(tmpdir(),'usage-native-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const saved={OMP_WEB_CC_EXECUTABLE:process.env.OMP_WEB_CC_EXECUTABLE,OMP_WEB_CODEX_EXECUTABLE:process.env.OMP_WEB_CODEX_EXECUTABLE};
 for(const[name,key]of [['claude','OMP_WEB_CC_EXECUTABLE'],['codex','OMP_WEB_CODEX_EXECUTABLE']]){await writeFile(join(root,name),'#!/bin/sh\nexit 97\n',{mode:0o755});process.env[key]=join(root,name)}
 t.after(()=>{for(const[k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v}globalThis.__ompWebUsageCache=undefined;globalThis.__ompWebSubscriptions=undefined});
 globalThis.__ompWebUsageCache=undefined;globalThis.__ompWebSubscriptions=undefined;
 const calls=[];
 t.mock.method(ClaudeCodeSession.prototype,'start',async()=>{calls.push('claude:init')});
 t.mock.method(ClaudeCodeSession.prototype,'send',async command=>{assert.equal(command.type,'get_native_usage');calls.push('claude:usage');return {subscription_type:'pro',rate_limits:{seven_day:{utilization:10}},session:{model_usage:{}}}});
 t.mock.method(CodexRpcClient.prototype,'start',async()=>{calls.push('codex:init')});
 t.mock.method(CodexRpcClient.prototype,'request',async method=>{
  calls.push(method);
  if(method==='account/read')return account;
  if(method==='account/rateLimits/read')return {rateLimits:{secondary:{windowDurationMins:10080,usedPercent:20,resetsAt:null}}};
  if(method==='account/usage/read')return {summary:{lifetimeTokens:1234}};
  throw Error('Unexpected native operation: '+method);
 });
 const reports=await Promise.all(Array.from({length:6},(_,i)=>getSubscriptionUsage('nonexistent-'+i)));
 assert.equal(calls.filter(c=>c==='claude:usage').length,1);assert.equal(calls.filter(c=>c==='account/usage/read').length,1);
 assert.equal(reports[0].subscriptions[1].totalTokens,'1234');assert.equal(reports[0].subscriptions[0].totalTokens,null);
 assert.ok(!calls.includes('turn/start'));
});
test('usage requests require web authentication and same-origin policy before native access',async t=>{
 const {cookie}=await useTestWebLogin(t);
 const request=origin=>new Request('http://localhost/api/usage',{headers:{host:'localhost',...(origin?{origin}:{})}});
 assert.equal((await GET(request())).status,401);assert.equal((await GET(request('https://evil.invalid'))).status,403);
 assert.equal((await GET(new Request('http://localhost/api/usage?sessionId=bad%2Fid',{headers:{host:'localhost',cookie}}))).status,400);
});
