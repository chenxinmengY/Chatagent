// Installed adapter and SDK, synthetic account and local fetch only; apply() is never loaded.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {registerHooks} from 'node:module';
import {nativeMessages} from '../../packages/dsh-adapter/antigravity.mjs';
import {installLegacyAntigravityTools} from '../../packages/dsh-bridge/legacy-antigravity.mjs';
const sdk=process.env.CHATAGENT_DSH_SDK??'D:/dsh/resources/app/dsh/node_modules/@deepseek-ai';
const parent=pathToFileURL(path.join(sdk,'../../package.json')).href;
registerHooks({resolve(specifier,context,next){return next(specifier,specifier.startsWith('@deepseek-ai/')?{...context,parentURL:parent}:context);}});
const plugin=process.env.CHATAGENT_GEMINI_POOL??path.join(os.homedir(),'.dsh/profiles/desktop/node_modules/dsh-gemini-pool');
const {AntigravityPoolAdapter}=await import(pathToFileURL(path.join(plugin,'lib/index.js')).href);
const llm=await import(pathToFileURL(path.join(sdk,'dsh-llm/lib/index.js')).href);
const {Context}=await import(pathToFileURL(path.join(sdk,'cordis/lib/index.js')).href);
const {createUserMessage,createAssistantMessage,createToolResultMessage}=llm;
const account={id:'synthetic',email:'synthetic@example.invalid',access:'fake-access',refresh:'fake-refresh',projectId:'fake-project',expires:Date.now()+3600000};
const pool={init:async()=>{},getCandidateAccounts:async()=>[account],clearCooldownUntil:async()=>{},markCooldown:async()=>{},addOrUpdateAccount:async()=>{throw Error('NO_CREDENTIAL_WRITES');}};
const settings={read:async()=>({enabledModelIds:['gemini-3.8-flash'],catalogModels:[]})};
const adapter=new AntigravityPoolAdapter(pool,settings);
const source={kind:'model',provider:'antigravity',model:'gemini-3.8-flash'};
const user=createUserMessage({source:{kind:'synthetic'},content:[{type:'text',text:'What is the fixture value?'}]});
let captured,first=true;globalThis.fetch=async(input,init)=>{
 const url=new URL(input);if(url.pathname==='/v1internal:fetchAvailableModels')return Response.json({});
 if(url.pathname!=='/v1internal:streamGenerateContent')throw Error('NO_EXTERNAL_FETCH');
 captured=JSON.parse(init.body);
 const parts=first?[{functionCall:{name:'fixture_lookup',args:{}},thoughtSignature:'synthetic-signature'}]:[{text:'OK'}];first=false;
 return new Response('data: '+JSON.stringify({response:{candidates:[{content:{parts},finishReason:'STOP'}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:1}}})+'\n\n',{headers:{'Content-Type':'text/event-stream'}});
};
const assembler=new llm.BlockAssembler();
for await(const chunk of adapter.stream({provider:'antigravity',model:'gemini-3.8-flash',maxTokens:64,messages:[user],tools:[{name:'fixture_lookup',description:'Synthetic fixture',parameters:{type:'object',properties:{}}}],sessionId:'synthetic-protocol-check'}))assembler.push(chunk);
const replayState=assembler.replayState,blocks=assembler.blocks(),call=blocks.find(b=>b.type==='tool-call');
if(!call||!replayState?.blocks?.some(b=>b.type==='tool-call'&&b.thoughtSignature==='synthetic-signature'))throw Error('SIGNED_TOOL_STATE_REQUIRED_BEFORE_DISPATCH');
const messages=[user,createAssistantMessage({source:{...source,replayState},content:blocks}),createToolResultMessage({callId:call.id,content:[{type:'text',text:'FIXTURE_RESULT'}],isError:false})];
if(messages[2].toolCallId!==call.id)throw Error('SDK_TOOL_CALL_ID_MISSING');
const results=[];
for(const [label,input]of [['before',messages],['converted',nativeMessages(messages)]]){
 for await(const chunk of adapter.stream({provider:'antigravity',model:'gemini-3.8-flash',reasoningEffort:'low',maxTokens:64,messages:input,tools:[],sessionId:'synthetic-protocol-check'})){}
 const parts=captured.request.contents.flatMap(m=>m.parts);
 results.push({label,functionCalls:parts.filter(p=>p.functionCall).length,functionResponses:parts.filter(p=>p.functionResponse).length,resultMistakenForUserText:parts.some(p=>p.text==='FIXTURE_RESULT'),thinking:captured.request.generationConfig.thinkingConfig});
}
const ctx=new Context();let dispose;
try{
 await ctx.plugin(llm.default,{});ctx.llm.registerAdapter(['antigravity'],adapter);
 dispose=installLegacyAntigravityTools(ctx,'synthetic-protocol-check');
 const old=JSON.stringify(messages);
 for(const [label,sessionId]of [['sdk-fixed','synthetic-protocol-check'],['other-chat-unchanged','other-chat']]){
  const request=Object.freeze({provider:'antigravity',model:'gemini-3.8-flash',reasoningEffort:'low',maxTokens:64,messages:Object.freeze(messages),tools:[],sessionId});
  const prepared=await ctx.llm.prepareCall({provider:request.provider,model:request.model,reasoningEffort:request.reasoningEffort,maxTokens:64});
  for await(const chunk of prepared.stream(request)){if(chunk.type==='finish'&&chunk.reason.kind!=='stop')throw Error('SDK_REQUEST_FAILED');}
  const parts=captured.request.contents.flatMap(m=>m.parts);
  if(!parts.some(p=>p.functionCall&&p.thought_signature==='synthetic-signature'))throw Error('SIGNED_TOOL_STATE_LOST');
  const calls=parts.filter(p=>p.functionCall),responses=parts.filter(p=>p.functionResponse),pairedToolNames=calls.length===1&&responses.length===1&&calls[0].functionCall.name===responses[0].functionResponse.name&&responses[0].functionResponse.response.output==='FIXTURE_RESULT';
  results.push({label,functionResponses:responses.length,pairedToolNames,resultMistakenForUserText:parts.some(p=>p.text==='FIXTURE_RESULT')});
 }
 if(JSON.stringify(messages)!==old)throw Error('CANONICAL_HISTORY_MUTATED');
 if(!results.find(r=>r.label==='sdk-fixed').pairedToolNames||results.find(r=>r.label==='other-chat-unchanged').functionResponses!==0)throw Error('COMPATIBILITY_SCOPE_FAILED');
}finally{dispose?.();await ctx.fiber.dispose();}
if(process.argv[2])fs.writeFileSync(process.argv[2],JSON.stringify({externalCalls:0,signedReplayStatePreserved:true,results},null,2));
console.log(JSON.stringify({externalCalls:0,signedReplayStatePreserved:true,results}));
