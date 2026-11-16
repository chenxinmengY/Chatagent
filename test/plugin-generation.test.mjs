import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {pathToFileURL} from 'node:url';
import {pluginGenerator} from '../packages/dsh-bridge/plugin-generation.mjs';
const sdk=process.env.CHATAGENT_DSH_LLM??'D:/dsh/resources/app/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
const llm=fs.existsSync(sdk)?await import(pathToFileURL(sdk).href):null;
function fixture(chunks){let calls=0;const service={async *stream(){calls++;for(const chunk of chunks)yield chunk;}},agent={options:{provider:'synthetic',model:'synthetic'},session:{requestHeader:()=>null}},ctx={get:key=>key==='llm'?service:null};return {generate:pluginGenerator({ctx,agent,llm}),calls:()=>calls};}
for(const [kind,expected] of [['error','PLUGIN_MODEL_FAILED'],['max-tokens','PLUGIN_OUTPUT_LIMIT'],['aborted','PLUGIN_MODEL_ABORTED']])test('plugin generation retains usage for '+kind+' without publishing partial output or retrying',{skip:!llm},async()=>{
 const usage={inputTokens:20,outputTokens:4},reason={kind,failure:{code:'SYNTHETIC_FAILURE',message:'private upstream details'}};
 const {generate,calls}=fixture([{type:'text-delta',index:0,text:'incomplete'},{type:'usage',usage},{type:'finish',reason}]);let recorded;
 await assert.rejects(generate({prompt:'fixture',signal:new AbortController().signal,onUsage:value=>recorded=value}),e=>{assert.equal(e.message,expected);assert.deepEqual(e.details,{finishKind:kind,failureCode:'SYNTHETIC_FAILURE'});assert.ok(!JSON.stringify(e.details).includes('private'));return true;});assert.deepEqual(recorded,usage);assert.equal(calls(),1);
});
test('plugin generation requires an explicit completed stream and preserves known usage',{skip:!llm},async()=>{
 const usage={inputTokens:10,outputTokens:2};let recorded;
 const {generate}=fixture([{type:'text-delta',index:0,text:'complete fixture'},{type:'usage',usage},{type:'finish',reason:{kind:'stop'}}]);assert.equal(await generate({prompt:'fixture',signal:new AbortController().signal,onUsage:u=>recorded=u}),'complete fixture');assert.deepEqual(recorded,usage);
 const missing=fixture([{type:'text-delta',index:0,text:'unfinished transport'}]);await assert.rejects(missing.generate({prompt:'fixture',signal:new AbortController().signal}),/PLUGIN_OUTPUT_INCOMPLETE/);
});

test('the text-only Notion transport cannot be treated as vision even if model metadata advertises images',{skip:!llm},async()=>{
 let uploaded=0,calls=0;const service={resolveModelInfo:async()=>({inputModalities:['text','image']}),async *stream(){calls++;yield {type:'finish',reason:{kind:'stop'}};}};
 const agent={options:{provider:'notion-chatagent',model:'gemini-3.7-flash'},session:{requestHeader:()=>null}},ctx={get:key=>key==='llm'?service:key==='attachments'?{saveImage:async()=>{uploaded++;return {};}}:null};
 await assert.rejects(pluginGenerator({ctx,agent,llm})({prompt:'只描述实际画面',images:[Buffer.from('frame')],signal:new AbortController().signal}),/PLUGIN_MODEL_VISION_REQUIRED/);assert.equal(calls,0);assert.equal(uploaded,0);
});
