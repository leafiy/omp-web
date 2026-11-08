import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=readFileSync(new URL('./useAgentSession.ts',import.meta.url),'utf8');
const handler=source.slice(source.indexOf('  const handleThinkingLevelChange ='),source.indexOf('  const handleToolPresetChange ='));
const compiled=ts.transpileModule(handler+'\nexports.handler=handleThinkingLevelChange;', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function setup(send,isNew=false) {
 const values=[],notices=[],calls=[];
 const scope={exports:{},Error,useCallback:fn=>fn,isNew,engine:'claude',thinkingChangeRevisionRef:{current:0},modelScopeRef:{current:'claude:/fixture'},sessionIdRef:{current:isNew?null:'claude:fixture'},ensuringNewSessionRef:{current:null},thinkingLevelOverrideRef:{current:null},mountedRef:{current:true},setThinkingLevel:v=>values.push(v),addNotice:n=>notices.push(n),sendAgentCommand:async(id,cmd)=>{calls.push({id,cmd});return send(cmd);}};
 vm.runInNewContext(compiled,scope);
 return {scope,values,notices,calls,run:scope.exports.handler};
}
test('auto is sent to Claude instead of silently updating only the dropdown',async()=>{
 const f=setup(async()=>({thinkingLevel:'medium'}));await f.run('auto');
 assert.equal(f.calls[0].cmd.type,'set_thinking_level');assert.equal(f.calls[0].cmd.level,'auto');assert.deepEqual(f.values,['medium']);
});
test('native caps are shown and failed changes do not fake success',async()=>{
 const f=setup(async()=>({thinkingLevel:'high'}));await f.run('max');assert.deepEqual(f.values,['high']);assert.equal(f.notices[0].type,'warning');
 const failed=setup(async()=>{throw Error('native rejected');});await failed.run('high');assert.deepEqual(failed.values,[]);assert.equal(failed.notices[0].message,'native rejected');
});
test('late replies from the previous conversation are ignored',async()=>{
 let resolve;const f=setup(()=>new Promise(r=>resolve=r));const pending=f.run('low');f.scope.sessionIdRef.current='claude:other';resolve({thinkingLevel:'low'});await pending;assert.deepEqual(f.values,[]);
});
test('new-session selection becomes an explicit startup preference without sending a prompt',async()=>{
 const f=setup(async()=>assert.fail('no live session'),true);await f.run('max');assert.deepEqual(f.values,['max']);assert.equal(f.scope.thinkingLevelOverrideRef.current,'max');assert.deepEqual(f.calls,[]);
});
