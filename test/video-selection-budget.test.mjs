import test from 'node:test';import assert from 'node:assert/strict';import {sandbox} from './helpers.mjs';
import {createDiyPlugins} from '../packages/diy-plugins/runtime.mjs';
test('self-selected video leaves room for model reasoning before the BV answer and preserves failure stage',async t=>{
 let clean,fail=false;const {root}=sandbox({after:fn=>clean=fn});
 const runtime=createDiyPlugins({root,sessionId:'synthetic',persona:()=>({name:'测试',text:'喜欢音乐'}),history:()=>[],publish:()=>{},
  mediaSource:async({select})=>{const bvid=await select([{bvid:'BV1rDx46VENg',title:'合成候选'}]);return {bvid,title:'合成视频',images:[],evidence:{frameCount:1}};},
  generate:async({maxTokens,images})=>{if(!images){if(fail||maxTokens<1024)throw Object.assign(Error('PLUGIN_OUTPUT_LIMIT'),{details:{finishKind:'max-tokens'}});return 'BV1rDx46VENg';}return '依据画面的合成感想';}});
 t.after(async()=>{await runtime.close();clean();});runtime.save('media-browser',{...runtime.status('media-browser')[0].settings,enabled:true});
 runtime.start('media-browser',{requestId:'new-selection'});await runtime.settled('media-browser');assert.equal(runtime.readJob('new-selection').state,'completed');
 fail=true;runtime.start('media-browser',{requestId:'failed-selection'});await runtime.settled('media-browser');const job=runtime.readJob('failed-selection');assert.equal(job.state,'failed');assert.equal(job.body.phase,'selection');assert.equal(job.body.finishKind,'max-tokens');assert.equal(runtime.status('media-browser')[0].records.length,1);
});
