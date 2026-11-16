import test from 'node:test';import assert from 'node:assert/strict';
import {createDiyPlugins} from '../packages/diy-plugins/runtime.mjs';import {sandbox} from './helpers.mjs';

function fixture(t,{source,publish=()=>{},generate}={}){
 let cleanup,clock=Date.parse('2026-11-07T05:00:00Z');const box=sandbox({after:fn=>cleanup=fn});
 const runtime=createDiyPlugins({root:box.root,sessionId:'video-budget-test',now:()=>clock,persona:()=>({name:'测试',text:'测试人格'}),history:()=>[],mediaSource:source,publish,generate:generate??(async({onUsage})=>{clock+=1000;onUsage?.({inputTokens:100,outputTokens:20});return '从抽帧和转写里看到了视频内容。';})});
 runtime.save('media-browser',{...runtime.status('media-browser')[0].settings,enabled:true,automatic:true,share:true,maxPerDay:1,intervalMinutes:1,tokenLimit:10000,windows:[{start:'00:00',end:'23:59'}]});
 t.after(async()=>{await runtime.close();cleanup();});return {runtime,advance:()=>{clock+=60001;}};
}
const bundle={title:'测试视频',bvid:'BV1rDx46VENg',images:[],subtitles:[],transcript:'测试文字',evidence:{frameCount:12,audioSeconds:60}};

test('failed autonomous videos keep their receipts and costs without consuming completed rounds',async t=>{
 let tries=0;const {runtime,advance}=fixture(t,{source:async()=>{if(++tries<=2)throw Error('PLUGIN_BILI_SOURCE_FAILED');return bundle;}});
 for(let i=0;i<3;i++){await runtime.tick();await runtime.settled('media-browser');if(i<2){const state=runtime.status('media-browser')[0];assert.equal(state.budget.rounds,0);assert.equal(state.budget.attempts,i+1);advance();}}
 const state=runtime.status('media-browser')[0];assert.equal(state.budget.rounds,1);assert.equal(state.budget.attempts,3);assert.equal(state.budget.tokens,120);assert.equal(state.budget.elapsedMs,1000);assert.equal(state.schedule.reason,'round-limit');assert.equal(state.jobs.filter(j=>j.state==='failed').length,2);assert.equal(state.records.length,1);
 advance();await runtime.tick();assert.equal(tries,3);
});

test('persistent failures stop at a separate attempt limit and still charge usage and elapsed time',async t=>{
 const {runtime,advance}=fixture(t,{source:async()=>bundle,generate:async({onUsage})=>{onUsage?.({inputTokens:100,outputTokens:20});throw Error('PLUGIN_MODEL_FAILED');}});
 for(let i=0;i<10;i++){await runtime.tick();await runtime.settled('media-browser');advance();}
 const state=runtime.status('media-browser')[0];assert.equal(state.budget.rounds,0);assert.equal(state.budget.attempts,10);assert.equal(state.budget.tokens,1200);assert.equal(state.budget.reservedTokens,0);assert.equal(state.schedule.reason,'attempt-limit');
 await runtime.tick();assert.equal(runtime.status('media-browser')[0].jobs.length,10);assert.throws(()=>runtime.start('media-browser',{requestId:'extra-auto',scheduled:true}),/PLUGIN_BUDGET_EXHAUSTED/);
 runtime.start('media-browser',{requestId:'explicit-new-invitation'});await runtime.settled('media-browser');assert.equal(runtime.readJob('explicit-new-invitation').state,'failed');assert.equal(runtime.status('media-browser')[0].budget.attempts,10);
});

test('a saved viewing record consumes a round even if later chat sharing fails',async t=>{
 const {runtime,advance}=fixture(t,{source:async()=>bundle,publish:()=>{throw Error('DELIVERY_FAILED');}});
 await runtime.tick();await runtime.settled('media-browser');const state=runtime.status('media-browser')[0];assert.equal(state.jobs[0].state,'failed');assert.equal(state.records.length,1);assert.equal(state.budget.rounds,1);assert.equal(state.schedule.reason,'round-limit');advance();await runtime.tick();assert.equal(runtime.status('media-browser')[0].jobs.length,1);
});
