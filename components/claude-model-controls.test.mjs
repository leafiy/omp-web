import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url,{jsx:{runtime:'automatic'},tsconfigPaths:true});
const {ChatInput,thinkingLevelOptions,filterModelOptions}=await jiti.import('./ChatInput.tsx');
const {I18nProvider}=await jiti.import('../hooks/useI18n.tsx');

test('Claude effort options are exactly native levels plus auto, including singleton catalogs',()=>{
 assert.deepEqual(thinkingLevelOptions('claude',['low','high','max']),['auto','low','high','max']);
 assert.deepEqual(thinkingLevelOptions('claude',['high']),['auto','high']);
 assert.deepEqual(thinkingLevelOptions('claude',[]),['auto']);
 assert.deepEqual(thinkingLevelOptions('claude',null),['auto']);
 assert.ok(!thinkingLevelOptions('claude',['off','minimal']).includes('off'));
});
test('model search includes resolved native IDs, not just aliases',()=>{
 const models=[{provider:'claude-code',modelId:'opus',name:'Native Opus',resolvedModel:'claude-opus-real'}];
 assert.deepEqual(filterModelOptions(models,'opus-real'),models);
});
test('real composer renders the canonical selection and an effort control',()=>{
 const html=renderToStaticMarkup(React.createElement(I18nProvider,null,React.createElement(ChatInput,{
  engine:'claude',onSend(){},onAbort(){},isStreaming:false,onModelChange(){},onThinkingLevelChange(){},
  model:{provider:'claude-code',modelId:'native-opus'},modelList:[{provider:'claude-code',id:'opus',name:'Native Opus',resolvedModel:'native-opus'}],
  thinkingLevel:'high',availableThinkingLevels:['low','high'],
 })));
 assert.match(html,/Native Opus/);assert.match(html,/Change model: native-opus/);assert.match(html,/Effort · high/);
 assert.match(html,/aria-label="Change Claude effort"/);
});
