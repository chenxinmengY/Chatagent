import test from 'node:test';
import assert from 'node:assert/strict';
import {installChatDispatch,projectChatMessages} from '../packages/dsh-bridge/chat-dispatch.mjs';

test('dispatch keeps the exact chat persona and evidence without deployment instructions or mutations',()=>{
 const messages=[{id:'s',role:'system',source:{kind:'system-prompt'},content:[{type:'text',text:'UNRELATED_GLOBAL_INSTRUCTIONS'}]},
  {id:'c',role:'user',source:{kind:'runtime-context',sections:[{name:'sandbox:policy',text:'UNRELATED_SANDBOX'},{name:'memory',text:'MEMORY_EVIDENCE'},{name:'chatagent:audio-input',text:'VOICE_EVIDENCE'}]},content:[{type:'text',text:'OLD_CONTEXT'}]},
  {id:'u',role:'user',source:{kind:'user'},content:[{type:'text',text:'说话'}]},
  {id:'a',role:'assistant',source:{kind:'model',replayState:{signature:'keep'}},content:[{type:'tool-call',id:'t',name:'remember',arguments:{text:'fact'}}]},
  {id:'t',role:'tool',toolCallId:'t',content:[{type:'text',text:'TOOL_EVIDENCE'}]}];
 const old=JSON.stringify(messages),persona='SYNTHETIC_PERSONA {{原文}} 不用句号';
 for(const message of messages)Object.freeze(message);Object.freeze(messages);
 const projected=projectChatMessages(messages,persona);
 assert.equal(projected[0].content[0].text,persona);assert.equal(projected[0].id,'s');
 assert.doesNotMatch(JSON.stringify(projected),/UNRELATED_GLOBAL|UNRELATED_SANDBOX|OLD_CONTEXT/);
 assert.deepEqual(projected[1].source.sections.map(s=>s.name),['memory','chatagent:audio-input']);
 assert.match(projected[1].content[0].text,/MEMORY_EVIDENCE.*\n\nVOICE_EVIDENCE/);
 assert.deepEqual(projected.slice(2),messages.slice(2));assert.equal(JSON.stringify(messages),old);
 assert.equal(projectChatMessages(messages.slice(2),persona)[0].role,'system');
});

test('adapter boundary scopes changes to registered chats, follows new adapters, and restores on disposal',async()=>{
 const listeners=new Map(),captured=[],adapter={async *stream(options){captured.push(options);yield {type:'finish',reason:{kind:'stop'}};}};
 const service={adapters:new Map([['one',{adapter}]])},ctx={get:name=>{assert.equal(name,'llm');return service;},on:(name,callback)=>{listeners.set(name,callback);return()=>listeners.delete(name);}};
 const original=adapter.stream,dispose=installChatDispatch(ctx,'private-chat',()=> 'PERSONA');
 const messages=[{role:'system',source:{kind:'system-prompt'},content:[{type:'text',text:'OTHER'}]}],tools=[{name:'remember'}];
 const request=Object.freeze({sessionId:'private-chat',messages,tools,provider:'one',model:'chosen',signal:new AbortController().signal});
 for await(const _ of adapter.stream(request)){}
 assert.equal(captured[0].messages[0].content[0].text,'PERSONA');assert.equal(captured[0].tools,tools);assert.equal(captured[0].model,'chosen');
 const other={...request,sessionId:'coding-chat'};for await(const _ of adapter.stream(other)){}assert.equal(captured[1],other);
 const second={async *stream(options){captured.push(options);yield {type:'finish',reason:{kind:'stop'}};}},secondOriginal=second.stream;
 service.adapters.set('two',{adapter:second});listeners.get('llm/adapters-updated')();for await(const _ of second.stream({...request,provider:'two'})){}
 assert.equal(captured[2].messages[0].content[0].text,'PERSONA');dispose();assert.equal(adapter.stream,original);assert.equal(second.stream,secondOriginal);
});

test('tool permissions filter frozen direct and prepared requests, track each turn and leave other sessions intact',async()=>{
 const listeners=new Map(),captured=[];
 const adapter={async *stream(options){captured.push(options);},async prepareCall(){return {stream:options=>this.stream(options)};}};
 const originalStream=adapter.stream,originalPrepare=adapter.prepareCall;
 const ctx={get:()=>({adapters:new Map([['synthetic',{adapter}]])}),on:(event,callback)=>{listeners.set(event,callback);return()=>listeners.delete(event);}};
 let allowed=new Set(['remember']);
 const close=installChatDispatch(ctx,'private-chat',()=> 'PERSONA',()=>allowed?name=>allowed.has(name):null);
 try{
  const tools=Object.freeze([{name:'remember'},{name:'chatagent_send_voice'},{name:'ops_bash'}].map(Object.freeze));
  const request=Object.freeze({sessionId:'private-chat',messages:Object.freeze([]),tools,provider:'synthetic',model:'fixture',signal:new AbortController().signal});
  const prepared=await adapter.prepareCall('synthetic','fixture',request.signal);
  for await(const _ of prepared.stream(request)){}
  assert.deepEqual(captured.at(-1).tools.map(t=>t.name),['remember']);assert.equal(captured.at(-1).signal,request.signal);
  allowed=new Set();for await(const _ of prepared.stream(request)){}assert.deepEqual(captured.at(-1).tools,[]);
  allowed=new Set(['chatagent_send_voice']);for await(const _ of adapter.stream(request)){}assert.deepEqual(captured.at(-1).tools.map(t=>t.name),['chatagent_send_voice']);
  const other=Object.freeze({...request,sessionId:'ordinary-chat'});for await(const _ of prepared.stream(other)){}assert.equal(captured.at(-1),other);
  allowed=null;for await(const _ of prepared.stream(request)){}assert.equal(captured.at(-1).tools,tools);
  assert.equal(request.tools,tools);assert.equal(tools.length,3);
 }finally{close();}
 assert.equal(adapter.stream,originalStream);assert.equal(adapter.prepareCall,originalPrepare);assert.equal(listeners.size,0);
});

test('课表直出覆盖直接和 prepared 流；只传当前问题和时间，其他会话正常流转',async()=>{
 const captured=[],adapter={async *stream(options){captured.push(options);yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:'主人快去睡觉'}};yield {type:'block-start',index:1,blockType:'tool-call'};yield {type:'block-end',index:1,block:{type:'tool-call',id:'c',name:'course-query__query',arguments:'{}'}};yield {type:'finish',reason:{kind:'tool-calls'}};},async prepareCall(){return {stream:options=>this.stream(options)};}};
 const ctx={get:()=>({adapters:new Map([['s',{adapter}]])}),on:()=>()=>{}};let value,query=true;
 const dispose=installChatDispatch(ctx,'chat',()=> 'PERSONA',()=>n=>n==='course-query__query',m=>m,()=>query?{reply:()=>value}:null);
 const messages=[{role:'assistant',content:[{type:'text',text:'OLD_CHAT'}]},{role:'user',source:{kind:'runtime-context',sections:[{name:'memory',text:'PERSONAL_MEMORY'},{name:'time-context',text:'CURRENT_TIME'}]}},{role:'user',source:{kind:'user'},content:[{type:'text',text:'今天什么课'}]}],request={sessionId:'chat',messages,tools:[{name:'remember'},{name:'course-query__query'}]};
 try{
  const prepared=await adapter.prepareCall();
  for(const run of [r=>adapter.stream(r),r=>prepared.stream(r)]){
   value=undefined;const call=[];for await(const e of run(request))call.push(e);assert.doesNotMatch(JSON.stringify(call),/睡觉/);assert.equal(call[1].block.name,'course-query__query');
   assert.doesNotMatch(JSON.stringify(captured.at(-1)),/OLD_CHAT|PERSONAL_MEMORY|PERSONA/);assert.match(JSON.stringify(captured.at(-1)),/CURRENT_TIME|今天什么课/);
   const count=captured.length;value='| 日期 | 时间 |\n| --- | --- |';const reply=[];for await(const e of run(request))reply.push(e);assert.equal(reply[1].block.text,value);assert.equal(captured.length,count);
  }
  query=false;for await(const _ of adapter.stream(request)){}assert.match(JSON.stringify(captured.at(-1)),/OLD_CHAT/);
  const other={...request,sessionId:'other'};for await(const _ of prepared.stream(other)){}assert.equal(captured.at(-1),other);
 }finally{dispose();}
});
