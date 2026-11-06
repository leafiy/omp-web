// Read-only fake executables. These tests never run an installer or a real model.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti=createJiti(import.meta.url);
const manager=await jiti.import('./tool-update.ts');
const {createOmpVersionReader}=await jiti.import('./omp-version.ts');
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'omp-version-test-'));
  const keys=['OMP_WEB_EXECUTABLE','OMP_CODING_AGENT_DIR','XDG_STATE_HOME'];
  const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  process.env.OMP_WEB_EXECUTABLE=join(root,'omp');process.env.OMP_CODING_AGENT_DIR=join(root,'agent');process.env.XDG_STATE_HOME=join(root,'state');
  const log=join(root,'calls');
  const script=v=>`#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = --version ] || exit 97\nprintf 'probe\\n' >> '${log}'\nprintf 'omp/${v}\\n'\n`;
  await writeFile(join(root,'omp'),script('1.2.3'),{mode:0o755});
  t.after(async()=>{for(const k of keys){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k]}await rm(root,{recursive:true,force:true})});
  return {root,log,script};
}
test('the settings view supplies a real OMP installedVersion without updating it',async t=>{
  const {log}=await fixture(t);
  // Before the fix the coordinator is the settings view, and omits this field.
  const snapshot=await (manager.getToolUpdateView??manager.getToolUpdates)();
  assert.equal(snapshot.tools.find(t=>t.tool==='omp').installedVersion,'1.2.3');
  assert.equal((await readFile(log,'utf8')).trim(),'probe');
});
test('concurrent opens share the version probe; replacing the binary invalidates the cache',async t=>{
  const {root,log,script}=await fixture(t);
  const snapshots=await Promise.all(Array.from({length:8},()=>manager.getToolUpdateView()));
  assert.ok(snapshots.every(s=>s.tools.find(t=>t.tool==='omp').installedVersion==='1.2.3'));
  assert.equal((await readFile(log,'utf8')).trim().split('\n').length,1);
  await writeFile(join(root,'replacement'),script('1.2.4'),{mode:0o755});await rename(join(root,'replacement'),join(root,'omp'));
  const next=await manager.getToolUpdateView();assert.equal(next.tools.find(t=>t.tool==='omp').installedVersion,'1.2.4');
  assert.equal((await readFile(log,'utf8')).trim().split('\n').length,2);
});
test('query failures do not hide other tools or leak raw executable output',async t=>{
  const {root}=await fixture(t);await writeFile(join(root,'omp'),"#!/bin/sh\nprintf 'private-output-not-a-version\\n'\n",{mode:0o755});
  const snapshot=await manager.getToolUpdateView(),omp=snapshot.tools.find(t=>t.tool==='omp');
  assert.equal(snapshot.tools.length,4);assert.equal(omp.installedVersion,undefined);assert.ok(omp.versionError);
  assert.equal(JSON.stringify(snapshot).includes('private-output-not-a-version'),false);
});
test('version queries have a bounded timeout',async t=>{
  const {root}=await fixture(t);await writeFile(join(root,'omp'),'#!/bin/sh\nexec /bin/sleep 20\n',{mode:0o755});
  const started=Date.now();const snapshot=await manager.getToolUpdateView();
  assert.ok(Date.now()-started<8000);assert.ok(snapshot.tools.find(t=>t.tool==='omp').versionError);
});
test('successful cache expires in five minutes and failed probes retry after ten seconds',async t=>{
  const {root}=await fixture(t);let now=0,calls=0,fail=false;
  const read=createOmpVersionReader({now:()=>now,probe:async()=>{calls++;if(fail)throw Error('private failure');return '\u001b[32momp/2.3.4\u001b[0m\n'}});
  const plan={tool:'omp',executable:join(root,'omp'),command:join(root,'omp'),args:['update']};
  assert.equal((await read(plan)).installedVersion,'2.3.4');
  now=299999;await read(plan);assert.equal(calls,1);
  now=300001;fail=true;assert.ok((await read(plan)).versionError);assert.equal(calls,2);
  now+=9000;await read(plan);assert.equal(calls,2);
  now+=1001;fail=false;assert.equal((await read(plan)).installedVersion,'2.3.4');assert.equal(calls,3);
});
test('a settings read does not probe a binary currently being updated',async t=>{
  const {log}=await fixture(t);
  const oldJob=globalThis.__ompWebToolUpdateJob,oldInvocation=process.env.INVOCATION_ID;
  process.env.INVOCATION_ID='test-version-update';
  globalThis.__ompWebToolUpdateJob={tool:'omp',id:'test',phase:'updating',invocation:'test-version-update',pid:process.pid,output:''};
  t.after(()=>{globalThis.__ompWebToolUpdateJob=oldJob;if(oldInvocation===undefined)delete process.env.INVOCATION_ID;else process.env.INVOCATION_ID=oldInvocation});
  assert.equal((await manager.getToolUpdateView()).job.phase,'updating');
  await assert.rejects(readFile(log),e=>e.code==='ENOENT');
});
