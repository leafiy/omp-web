import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJiti } from 'jiti';
import { useTestWebLogin } from './web-auth-test-helper.mjs';
const jiti=createJiti(import.meta.url);
const {performFileOperation:run,fileEntryVersion,parseFileOperation}=await jiti.import('./file-operations.ts');
const {createFileOperationHandler}=await jiti.import('./file-operation-http.ts');
async function fixture(t){const base=await fs.mkdtemp(path.join(os.tmpdir(),'omp-files-test-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));const root=path.join(base,'allowed'),outside=path.join(base,'outside');await fs.mkdir(root);await fs.mkdir(outside);return {base,root,outside,roots:new Set([root])}}
const version=async p=>fileEntryVersion(await fs.lstat(p));
const command=async(operation,source,destination)=>({operation,source,destination,sourceVersion:await version(source),confirm:true});
const rejects=(action,code)=>assert.rejects(action,e=>e.code===code);

test('creates empty files/directories and copies a tree without changing the original',async t=>{
 const {root,roots}=await fixture(t);const src=path.join(root,'source'),dest=path.join(root,'copy');
 await run({operation:'new-directory',destination:src},roots);await run({operation:'new-file',destination:path.join(src,'empty')},roots);await fs.writeFile(path.join(src,'text'),'synthetic');
 await run(await command('copy',src,dest),roots);assert.equal(await fs.readFile(path.join(dest,'text'),'utf8'),'synthetic');assert.equal(await fs.readFile(path.join(src,'text'),'utf8'),'synthetic');assert.equal((await fs.stat(path.join(dest,'empty'))).size,0);
});
test('moves files and directories without a shell or replacing the destination',async t=>{
 const {root,roots}=await fixture(t);const a=path.join(root,'-source;not-a-command'),b=path.join(root,'renamed');await fs.mkdir(a);await fs.writeFile(path.join(a,'file'),'contents');
 await run(await command('move',a,b),roots);assert.equal(await fs.readFile(path.join(b,'file'),'utf8'),'contents');await assert.rejects(fs.stat(a),{code:'ENOENT'});
 const f=path.join(b,'file'),g=path.join(b,'new-name');await run(await command('move',f,g),roots);assert.equal(await fs.readFile(g,'utf8'),'contents');await assert.rejects(fs.stat(f),{code:'ENOENT'});
});
test('rejects all existing destinations including empty directories, dangling symlinks and same path',async t=>{
 const {root,roots}=await fixture(t);const a=path.join(root,'a'),b=path.join(root,'b');await fs.writeFile(a,'A');await fs.writeFile(b,'B');
 for(const op of ['copy','move'])await rejects(run(await command(op,a,b),roots),'conflict');await rejects(run(await command('copy',a,a),roots),'conflict');
 await fs.unlink(b);await fs.symlink('/nonexistent/omp-files-test',b);await rejects(run(await command('move',a,b),roots),'conflict');assert.equal(await fs.readFile(a,'utf8'),'A');
 await fs.unlink(b);await fs.mkdir(b);await rejects(run({operation:'new-directory',destination:b},roots),'conflict');
});
test('deletion requires confirmation, checks source identity, and removes only the selected tree',async t=>{
 const {root,roots}=await fixture(t);const a=path.join(root,'a');await fs.mkdir(a);await fs.writeFile(path.join(a,'x'),'X');await fs.writeFile(path.join(root,'keep'),'KEEP');
 const c=await command('delete',a);await rejects(run({...c,confirm:false},roots),'invalid');assert.equal(await fs.readFile(path.join(a,'x'),'utf8'),'X');
 await run(c,roots);await assert.rejects(fs.stat(a),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(root,'keep'),'utf8'),'KEEP');
});
test('changed or replaced sources are not silently copied, moved or deleted',async t=>{
 const {root,roots}=await fixture(t);const a=path.join(root,'a');await fs.writeFile(a,'old');const c=await command('delete',a);await fs.writeFile(a,'new-longer');
 for(const op of ['copy','move','delete'])await rejects(run({...c,operation:op,destination:path.join(root,'b')},roots),'changed');assert.equal(await fs.readFile(a,'utf8'),'new-longer');
});
test('validates both paths, rejects traversal and sibling-prefix escapes before mutation',async t=>{
 const {root,outside,roots}=await fixture(t);const a=path.join(root,'a');await fs.writeFile(a,'A');await fs.writeFile(path.join(outside,'secret'),'SECRET');
 await rejects(run(await command('copy',a,path.join(outside,'b')),roots),'denied');await rejects(run(await command('delete',path.join(outside,'secret')),roots),'denied');
 assert.throws(()=>parseFileOperation({operation:'new-file',destination:root+'/../outside/no'}));assert.throws(()=>parseFileOperation({operation:'new-file',destination:'relative'}));
 assert.equal(await fs.readFile(path.join(outside,'secret'),'utf8'),'SECRET');
});
test('outside symlinks are copied/moved as links and deleted without following targets',async t=>{
 const {root,outside,roots}=await fixture(t);await fs.writeFile(path.join(outside,'keep'),'KEEP');await fs.symlink(outside,path.join(root,'escape'));
 await rejects(run({operation:'new-file',destination:path.join(root,'escape/new')},roots),'denied');
 const a=path.join(root,'a'),b=path.join(root,'copy');await fs.mkdir(a);await fs.symlink(outside,path.join(a,'link'));
 await run(await command('copy',a,b),roots);assert.equal(await fs.readlink(path.join(b,'link')),outside);assert.ok((await fs.lstat(path.join(b,'link'))).isSymbolicLink());
 await run(await command('move',path.join(b,'link'),path.join(b,'moved-link')),roots);assert.equal(await fs.readlink(path.join(b,'moved-link')),outside);
 await run(await command('delete',a),roots);await run(await command('delete',b),roots);
 assert.equal(await fs.readFile(path.join(outside,'keep'),'utf8'),'KEEP');await assert.rejects(fs.stat(a),{code:'ENOENT'});await assert.rejects(fs.stat(b),{code:'ENOENT'});
});
test('protects registered roots, their ancestors and Git metadata',async t=>{
 const {base,root,roots}=await fixture(t);const nested=path.join(root,'nested/project');await fs.mkdir(nested,{recursive:true});roots.add(nested);
 await assert.rejects(run(await command('delete',root),roots),e=>e.status===403);
 await rejects(run(await command('delete',path.join(root,'nested')),roots),'protected');
 await fs.mkdir(path.join(root,'.git'));await fs.writeFile(path.join(root,'.git/config'),'protected');await rejects(run(await command('delete',path.join(root,'.git/config')),roots),'protected');assert.ok(await fs.stat(base));
});
test('rejects copying a directory into itself and refuses oversized copies before creating output',async t=>{
 const {root,roots}=await fixture(t);const a=path.join(root,'a');await fs.mkdir(a);await rejects(run(await command('copy',a,path.join(a,'child')),roots),'invalid');
 const huge=path.join(a,'sparse');const f=await fs.open(huge,'w');await f.truncate(513*1024*1024);await f.close();await rejects(run(await command('copy',a,path.join(root,'copy')),roots),'too-large');await assert.rejects(fs.stat(path.join(root,'copy')),{code:'ENOENT'});
});
test('serializes competing browser mutations without automatic retries',async t=>{
 const {root,roots}=await fixture(t);const results=await Promise.allSettled([run({operation:'new-directory',destination:path.join(root,'a')},roots),run({operation:'new-directory',destination:path.join(root,'b')},roots)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'busy');
});
test('HTTP authentication and Origin guards run before root discovery or any mutation',async t=>{
 const {cookie}=await useTestWebLogin(t);let calls=0;const handler=createFileOperationHandler(async()=>{calls++;return new Set()});
 const req=(headers,body={operation:'new-file',destination:'/not-used'})=>new Request('http://localhost/api/file-operations',{method:'POST',headers:{host:'localhost','content-type':'application/json',...headers},body:JSON.stringify(body)});
 try{assert.equal((await handler(req({}))).status,401);assert.equal((await handler(req({origin:'https://foreign.invalid'}))).status,403);assert.equal(calls,0);
 assert.equal((await handler(req({cookie},{operation:'execute',command:'no'}))).status,400);assert.equal(calls,0);
 assert.equal((await handler(req({cookie},{operation:'new-file',destination:'x'.repeat(20_000)}))).status,413);assert.equal(calls,0);
 }finally{/* login is restored by t.after */}
});
