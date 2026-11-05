import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {installLegacyAntigravityTools} from '../packages/dsh-bridge/legacy-antigravity.mjs';
import {nativeMessages} from '../packages/dsh-adapter/antigravity.mjs';
import {sandbox} from './helpers.mjs';

test('legacy tool projection scopes chats, preserves errors/history, supports HMR and restores adapter',()=>{
 const seen=[],hooks=new Set();
 class AntigravityPoolAdapter {stream(options){seen.push(options);return options;}}
 const adapter=new AntigravityPoolAdapter(),original=adapter.stream,service={adapters:new Map([['antigravity',{adapter}]])};
 const ctx={get:()=>service,on:(_name,callback)=>{hooks.add(callback);return ()=>hooks.delete(callback);}};
 const messages=Object.freeze([{role:'tool',toolCallId:'one',isError:true,content:[{type:'text',text:'fixture error'}]}]),request=Object.freeze({provider:'antigravity',sessionId:'a',messages});
 const closeA=installLegacyAntigravityTools(ctx,'a'),closeA2=installLegacyAntigravityTools(ctx,'a'),closeB=installLegacyAntigravityTools(ctx,'b');
 assert.equal(closeA.active(),true);
 adapter.stream(request);assert.equal(seen.at(-1).messages[0].content[0].type,'tool-result');assert.equal(seen.at(-1).messages[0].content[0].isError,true);assert.equal(messages[0].content[0].type,'text');
 assert.deepEqual(nativeMessages(nativeMessages(messages)),nativeMessages(messages),'Projection is idempotent');
 const other={...request,sessionId:'unrelated'};adapter.stream(other);assert.equal(seen.at(-1),other);
 const provider={...request,provider:'other'};adapter.stream(provider);assert.equal(seen.at(-1),provider);
 closeA();adapter.stream(request);assert.notEqual(seen.at(-1),request,'Second owner retains compatibility');
 const updated=new AntigravityPoolAdapter(),updatedOriginal=updated.stream;service.adapters.set('antigravity',{adapter:updated});for(const hook of hooks)hook();updated.stream(request);assert.notEqual(seen.at(-1),request);
 closeA2();assert.equal(closeA.active(),false);updated.stream(request);assert.equal(seen.at(-1),request);closeB();assert.equal(adapter.stream,original);assert.equal(updated.stream,updatedOriginal);assert.equal(hooks.size,0);
});

test('installed Gemini adapter and actual frozen SDK prepared calls serialize paired tool results without affecting other chats',t=>{
 const sdk=process.env.CHATAGENT_DSH_SDK??'D:/dsh/resources/app/dsh/node_modules/@deepseek-ai',plugin=process.env.CHATAGENT_GEMINI_POOL??path.join(os.homedir(),'.dsh/profiles/desktop/node_modules/dsh-gemini-pool');
 if(!fs.existsSync(path.join(sdk,'dsh-llm/lib/index.js'))||!fs.existsSync(path.join(plugin,'lib/index.js')))return t.skip('Optional DSH SDK and Gemini adapter unavailable');
 const {root}=sandbox(t),result=path.join(root,'result.json');
 execFileSync(process.execPath,['test/fixtures/legacy-antigravity-sdk.mjs',result],{encoding:'utf8',windowsHide:true,timeout:20000});
 const report=JSON.parse(fs.readFileSync(result));assert.equal(report.externalCalls,0);
 assert.equal(report.signedReplayStatePreserved,true);
 assert.equal(report.results.find(r=>r.label==='before').functionResponses,0);
 assert.equal(report.results.find(r=>r.label==='converted').functionResponses,1);
 assert.equal(report.results.find(r=>r.label==='sdk-fixed').functionResponses,1);
 assert.equal(report.results.find(r=>r.label==='sdk-fixed').pairedToolNames,true);
 assert.equal(report.results.find(r=>r.label==='other-chat-unchanged').functionResponses,0);
});
