import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {isolateChatPrompt,CHAT_PROMPT_SECTION} from '../../packages/dsh-bridge/chat-prompt.mjs';
import {installChatDispatch} from '../../packages/dsh-bridge/chat-dispatch.mjs';
import {bridgeReply} from '../../packages/dsh-bridge/host.mjs';
const sdkRoot=path.resolve(process.argv[2]),reportFile=path.resolve(process.argv[3]);
const load=name=>import(pathToFileURL(path.join(sdkRoot,name,'lib/index.js')).href);
const [cordis,sessions,agents,llm,prompt,tools,projection,executor,loop]=await Promise.all(['cordis','dsh-session','dsh-agent','dsh-llm','dsh-system-prompt','dsh-tools','dsh-session-projection','dsh-tool-executor-native','dsh-agent-loop'].map(load));
const ctx=new cordis.Context(),captured=[];let closeDispatch,oldHook;
try{
 for(const [module,config] of [[sessions,{}],[agents,{}],[llm,{}],[prompt,{}],[tools,{}],[projection,{}],[executor,{}]])await ctx.plugin(module.default??module,config);
 class SyntheticAdapter extends llm.LlmAdapter {async *stream(options){captured.push(options);yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'合成回复正常'};yield {type:'block-end',index:0,block:{type:'text',text:'合成回复正常'}};yield {type:'finish',reason:{kind:'stop'}};}}
 ctx.llm.registerAdapter(['synthetic'],new SyntheticAdapter());
 await ctx.plugin(loop.default,{agents:[]});
 const agent=await ctx.agentLoop.create('chatagent-sdk022-synthetic',{provider:'synthetic',model:'fixture'});
 const other=await ctx.agentLoop.create('ordinary-sdk022-synthetic',{provider:'synthetic',model:'fixture'});
 const definition=name=>({name,description:'Synthetic tool',parameters:{type:'object',properties:{}},output:{schema:{type:'object',properties:{text:{type:'string'}},required:['text']},render:(_,r)=>[{type:'text',text:r.text}]},execute:()=>({text:'fixture'})});
 ctx.tools.register(definition('global_tool'));agent.ctx.tools.register(definition('allowed_local'));agent.ctx.tools.register(definition('denied_local'));
 agent.ctx.systemPrompt.section({name:CHAT_PROMPT_SECTION,order:0,interpolate:false,text:'SYNTHETIC_CHAT_PERSONA'});
 agent.ctx.on('system-prompt/assemble',async(_,context,next)=>{const value=await next();return context.agent===agent?isolateChatPrompt(value):value;},{prepend:true});
 let incomingHasTools;
 oldHook=agent.ctx.on('system-prompt/assemble',async(_,context,next)=>{const value=await next();incomingHasTools=Array.isArray(value.tools);return {...value,tools:value.tools.filter(t=>t.name==='allowed_local')};});
 await assert.rejects(agent.ctx.systemPrompt.assemble({scope:agent,agent}),/Cannot read properties of undefined \(reading 'filter'\)/);assert.equal(incomingHasTools,false);oldHook();oldHook=null;
 let permitted=new Set(['allowed_local']);closeDispatch=installChatDispatch(ctx,agent.session.id,()=> 'SYNTHETIC_CHAT_PERSONA',()=>name=>permitted.has(name));
 async function send(target,id){target.followup(llm.createUserMessage({source:{kind:'user',rpcId:id},content:[{type:'text',text:'你好'}]}));await target.whenIdle();return bridgeReply(target.session.snapshotEvents(),id);}
 assert.equal(await send(agent,'fixed-first'),'合成回复正常');
 assert.deepEqual(captured.at(-1).tools.map(t=>t.name),['allowed_local']);
 permitted=new Set();assert.equal(await send(agent,'fixed-second'),'合成回复正常');assert.deepEqual(captured.at(-1).tools,[]);
 assert.equal(await send(other,'ordinary'),'合成回复正常');assert.ok(captured.at(-1).tools.some(t=>t.name==='global_tool'));
 assert.equal(captured.length,3);const report={sdk:'0.2.2-rc.1',oldFilterErrorReproduced:true,promptCallbackOmitsTools:true,fixedNativeReplies:2,ordinarySessionUnchanged:true,perChatToolPermissionsVerified:true,externalModelCalls:0,syntheticModelCalls:captured.length,productionTouched:false};
 fs.writeFileSync(reportFile,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{oldHook?.();closeDispatch?.();await ctx.fiber.dispose();}
