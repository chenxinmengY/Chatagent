import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {installChatDispatch} from '../../packages/dsh-bridge/chat-dispatch.mjs';
import {WINDOW_SOURCE,RECENT_MARKER} from '../../packages/dsh-bridge/chat-continuity.mjs';
const parentURL='file:///D:/dsh/resources/app/dsh/package.json';
registerHooks({resolve(specifier,context,next){return next(specifier,specifier.startsWith('@deepseek-ai/')?{...context,parentURL}:context);}});
const {Context}=await import('@deepseek-ai/cordis');
const llm=await import('@deepseek-ai/dsh-llm'),pi=await import('@deepseek-ai/dsh-llm-pi-ai');
const ctx=new Context(),captured=[];
globalThis.fetch=async(input,init)=>{
 const request=typeof input==='string'||input instanceof URL?new Request(input,init):input;
 assert.equal(new URL(request.url).hostname,'synthetic.invalid');
 captured.push(JSON.parse(await request.text()));
 const first={id:'fixture',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta:{role:'assistant',content:'OK'},finish_reason:null}]},last={...first,choices:[{index:0,delta:{},finish_reason:'stop'}]};
 return new Response('data: '+JSON.stringify(first)+'\n\ndata: '+JSON.stringify(last)+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
};
let dispose;
try{
 await ctx.plugin(llm.default,{});
 ctx.provide('credentials',{resolve:async()=>({value:'synthetic-key',source:'fixture'}),readRecord:async()=>undefined,listRecords:async()=>[]});
 await ctx.plugin(pi,{providers:{'synthetic-route':{api:'openai-completions',baseURL:'https://synthetic.invalid/v1',apiKeyEnv:'SYNTHETIC_KEY',models:[{id:'fixture',input:['text'],reasoningEfforts:false}],retryPolicy:{mode:'normal',maxRetries:0}}}});
 dispose=installChatDispatch(ctx,'private-chat',()=> 'CHAT_PERSONA {{字面量}}');
 const history=[{id:'old-user',role:'user',at:1,text:'之前吃了什么'},{id:'old-assistant',role:'assistant',at:2,text:'黄焖鸡，汤汁拌米饭超香'},{id:'new-user',role:'user',at:3,text:'还记得黄焖鸡吗'}];
 const messages=[{id:'s',role:'system',source:{kind:'system-prompt'},content:[{type:'text',text:'UNRELATED_GLOBAL_TEST_INSTRUCTIONS'}]},llm.createUserMessage({source:{kind:WINDOW_SOURCE,form:'relay'},content:[{type:'text',text:RECENT_MARKER+history.map(JSON.stringify).join('\n')}]})];
 const original=JSON.stringify(messages);
 for(const sessionId of ['private-chat','coding-chat']){
  const prepared=await ctx.llm.prepareCall({provider:'synthetic-route',model:'fixture',maxTokens:64});
  const options=Object.freeze({...prepared.config,sessionId,messages:Object.freeze(messages),tools:[{name:'fixture_lookup',description:'Synthetic lookup',parameters:{type:'object',properties:{}}}],signal:AbortSignal.timeout(5000)});
  for await(const chunk of prepared.stream(options))if(chunk.type==='finish')assert.equal(chunk.reason.kind,'stop',JSON.stringify(chunk));
 }
 assert.equal(captured.length,2);assert.equal(captured[0].messages[0].content,'CHAT_PERSONA {{字面量}}');
 assert.equal(captured[1].messages[0].content,'UNRELATED_GLOBAL_TEST_INSTRUCTIONS');
 assert.deepEqual(captured[0].messages.slice(1).map(m=>m.role),['user','assistant','user']);assert.equal(captured[0].messages[2].content,'黄焖鸡，汤汁拌米饭超香');
 assert.equal(captured[0].tools[0].function.name,'fixture_lookup');assert.equal(JSON.stringify(messages),original);
 console.log(JSON.stringify({ok:true,installedDshSdk:true,preparedCallProjectionVerified:true,otherChatUnchanged:true,toolsPreserved:true,externalCalls:0}));
}finally{dispose?.();await ctx.fiber.dispose();}
