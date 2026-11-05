import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
import {sandbox} from './helpers.mjs';
import {mediaSettings,validateMediaPolicy,scheduleDue,tokenTotal} from '../packages/diy-plugins/media-policy.mjs';
import {createDiyPlugins} from '../packages/diy-plugins/runtime.mjs';
import {recordDay,orderedRecords,dateCounts,videoGroups} from '../apps/web/plugin-records.js';
const policy=()=>mediaSettings({enabled:true,automatic:true,maxPerDay:3,intervalMinutes:15});
test('media policy migrates quiet hours without enabling idle browsing and validates limits',()=>{
 const migrated=mediaSettings({quietStart:22,quietEnd:8,enabled:false,automatic:false,maxPerDay:2,intervalMinutes:180});assert.deepEqual(migrated.windows,[{start:'08:00',end:'22:00'}]);assert.equal(migrated.allowIdleOutsideWindows,false);assert.equal(migrated.enabled,false);validateMediaPolicy(migrated);
 for(const bad of [{roundMinutes:0},{dailyMinutes:-1},{tokenLimit:9999},{maxPerDay:21},{windows:[{start:'22:00',end:'22:00'}]},{windows:[{start:'24:00',end:'01:00'}]},{allowIdleOutsideWindows:'true'}])assert.throws(()=>validateMediaPolicy({...policy(),...bad}),/PLUGIN_SETTINGS_INVALID/);
 validateMediaPolicy({...policy(),maxPerDay:0,dailyMinutes:0,windows:[]});
});
test('Beijing windows, overnight ranges, gaps, zero limits and idle rules determine scheduling',()=>{
 const at=Date.parse('2026-11-05T15:00:00Z'),value={...policy(),windows:[{start:'22:00',end:'02:00'}],allowIdleOutsideWindows:false};assert.equal(scheduleDue(value,{now:at}),true);assert.equal(scheduleDue(value,{now:at,lastStart:at-60000}),false);assert.equal(scheduleDue({...value,maxPerDay:0},{now:at}),false);
 const outside={...value,windows:[],allowIdleOutsideWindows:true};assert.equal(scheduleDue(outside,{now:at}),false);assert.equal(scheduleDue(outside,{now:at,lastChat:at-31*60000}),true);assert.equal(scheduleDue(outside,{now:at,lastChat:at-5*60000}),false);
 assert.equal(scheduleDue(value,{now:Date.parse('2026-11-05T17:59:00Z')}),true);assert.equal(scheduleDue(value,{now:Date.parse('2026-11-05T18:00:00Z')}),false);
});
test('records retain imported dates, separate unknown dates, group matching videos and preserve repeated feelings',()=>{
 const rows=orderedRecords({records:[{id:'new',date:'2026-11-05',bvid:'BV1rDx46VENg',text:'new'}],imported:[{id:'old',at:null,date:'2026-11-04',text:'old'},{id:'v1',at:Date.parse('2026-11-04T16:01:00Z'),bvid:'BV1rDx46VENg',text:'first'}]});
 assert.equal(recordDay(rows.find(r=>r.id==='old')),'2026-11-04');assert.equal(recordDay({at:null}),'日期不详');assert.deepEqual(dateCounts(rows),[['2026-11-05',2],['2026-11-04',1]]);const groups=videoGroups(rows);assert.equal(groups.find(g=>g.bvid==='BV1rDx46VENg').rows.length,2);
});
function runtimeFixture(t,{known=true}={}){let cleanup;const box=sandbox({after:fn=>cleanup=fn});let at=Date.parse('2026-11-05T05:00:00Z'),calls=0;const runtime=createDiyPlugins({root:path.join(box.root,'plugins'),sessionId:'test',now:()=>at,persona:()=>({name:'测试',text:'测试'}),history:()=>[],publish:()=>{throw Error('unexpected publish');},mediaSource:async()=>({title:'视频',bvid:'BV1rDx46VENg',images:[],evidence:{frameCount:1,audioSeconds:10}}),generate:async args=>{calls++;at+=1000;if(known)args.onUsage?.({inputTokens:200,outputTokens:100,cacheReadTokens:50});return '实际感受';}});t.after(async()=>{await runtime.close();cleanup();});runtime.save('media-browser',{...runtime.status('media-browser')[0].settings,enabled:true,automatic:true,maxPerDay:1,windows:[{start:'12:00',end:'14:00'}]});return {runtime,calls:()=>calls};}
test('manual media invitations do not consume automatic quotas; usage and elapsed time survive configuration saves',async t=>{
 const {runtime}=runtimeFixture(t);runtime.start('media-browser',{requestId:'manual'});await runtime.settled('media-browser');assert.equal(runtime.status('media-browser')[0].budget.rounds,0);
 await runtime.tick();await runtime.settled('media-browser');const before=runtime.status('media-browser')[0].budget;assert.equal(before.rounds,1);assert.equal(before.tokens,350);assert.equal(before.elapsedMs,1000);assert.equal(before.reservedTokens,0);runtime.save('media-browser',{...runtime.status('media-browser')[0].settings,roundMinutes:30});assert.deepEqual(runtime.status('media-browser')[0].budget,before);await runtime.tick();assert.equal(runtime.status('media-browser')[0].jobs.length,2);
 runtime.start('media-browser',{requestId:'manual-after-limit'});await runtime.settled('media-browser');assert.equal(runtime.readJob('manual-after-limit').state,'completed');assert.deepEqual(runtime.status('media-browser')[0].budget,before);
});
test('missing model usage reserves budget rather than treating it as free; imported metadata survives API',async t=>{
 const {runtime,calls}=runtimeFixture(t,{known:false});await runtime.tick();await runtime.settled('media-browser');const status=runtime.status('media-browser')[0];assert.equal(status.budget.reservedTokens,status.settings.tokenLimit);runtime.save('media-browser',{...status.settings,maxPerDay:3});await runtime.tick();assert.equal(calls(),1);assert.equal(tokenTotal(undefined),null);assert.equal(tokenTotal({inputTokens:10,outputTokens:2,totalTokens:12,cacheReadTokens:8}),12);
});
