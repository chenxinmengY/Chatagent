import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {sandbox} from './helpers.mjs';import {createDiyPlugins} from '../packages/diy-plugins/runtime.mjs';import {videoId,allowedMediaUrl} from '../packages/diy-plugins/media-source.mjs';
import {startService} from '../apps/service/server.mjs';
function fixture(t,options={}){let cleanup;const box=sandbox({after:fn=>cleanup=fn});let calls=0;const publications=[];const root=path.join(box.root,'plugins');const runtime=createDiyPlugins({root,sessionId:'isolated-chat',generate:async()=>{calls++;return '今天和你聊了许多，我把这些小事写在日记里。';},persona:()=>({name:'测试鱼',text:'只依据当前聊天。'}),history:()=>[{role:'user',text:'今天去上课了'}],publish:p=>publications.push(p),now:()=>Date.parse('2026-11-05T14:00:00Z'),...options});t.after(async()=>{await runtime.close();cleanup();});return {runtime,root,publications,calls:()=>calls};}
test('DIY plugins default off, settings use CAS, diary is idempotent and only shares when explicitly enabled',async t=>{
 const {runtime,publications,calls}=fixture(t);assert.throws(()=>runtime.start('fish-notebook',{requestId:'first'}),/PLUGIN_DISABLED/);await runtime.tick();assert.equal(calls(),0);
 const original=runtime.status('fish-notebook')[0].settings;runtime.save('fish-notebook',{...original,enabled:true});assert.throws(()=>runtime.save('fish-notebook',original),/PLUGIN_SETTINGS_CHANGED/);
 runtime.start('fish-notebook',{requestId:'first'});await runtime.settled('fish-notebook');assert.equal(runtime.readJob('first').state,'completed');assert.equal(publications.length,0);
 runtime.start('fish-notebook',{requestId:'first'});runtime.start('fish-notebook',{requestId:'second'});await runtime.settled('fish-notebook');assert.equal(calls(),1);assert.equal(runtime.status('fish-notebook')[0].records.length,1);
 assert.throws(()=>runtime.start('fish-notebook',{requestId:'first',action:'ask'}),/PLUGIN_REQUEST_CONFLICT/);
 const current=runtime.status('fish-notebook')[0].settings;runtime.save('fish-notebook',{...current,share:true});runtime.start('fish-notebook',{requestId:'third'});await runtime.settled('fish-notebook');assert.equal(publications.length,1);
});
test('scheduled notebook runs once and three asks share the diary',async t=>{
 const {runtime,calls}=fixture(t);runtime.save('fish-notebook',{...runtime.status('fish-notebook')[0].settings,enabled:true,automatic:true});await runtime.tick();await runtime.settled('fish-notebook');await runtime.tick();assert.equal(calls(),1);
 for(let i=1;i<=3;i++){runtime.start('fish-notebook',{requestId:'ask-'+i,action:'ask'});await runtime.settled('fish-notebook');assert.equal(runtime.readJob('ask-'+i).state,'completed');}
 assert.equal(calls(),3);assert.equal(runtime.readJob('ask-3').body.answer,runtime.status('fish-notebook')[0].records[0].text);
});
test('media records preserve actual evidence, cancel stops publication and unknown tasks never auto-replay',async t=>{
 const mediaSource=async()=>({title:'测试视频',bvid:'BV1rDx46VENg',images:[],subtitles:[],transcript:'测试语音',evidence:{frameCount:12,audioSeconds:60}});
 const {runtime,root,publications}=fixture(t,{mediaSource});runtime.save('media-browser',{...runtime.status('media-browser')[0].settings,enabled:true,share:true});runtime.start('media-browser',{requestId:'watch-1'});await runtime.settled('media-browser');assert.equal(runtime.status('media-browser')[0].records[0].evidence.audioSeconds,60);assert.equal(publications.length,1);
 runtime.start('media-browser',{requestId:'watch-2'});runtime.stop('media-browser');await runtime.settled('media-browser');assert.equal(runtime.readJob('watch-2').state,'cancelled');assert.equal(publications.length,1);
 const db=new DatabaseSync(path.join(root,'plugins.sqlite'));db.prepare("UPDATE jobs SET state='unknown' WHERE id='watch-2'").run();db.close();runtime.save('media-browser',{...runtime.status('media-browser')[0].settings,automatic:true,quietStart:0,quietEnd:0});await runtime.tick();assert.equal(runtime.status('media-browser')[0].jobs.length,2);
});
test('B站 source restricts video URLs and download origins',()=>{assert.equal(videoId('https://www.bilibili.com/video/BV1rDx46VENg'),'BV1rDx46VENg');assert.equal(videoId(''),null);assert.throws(()=>videoId('http://127.0.0.1/a'));assert.throws(()=>allowedMediaUrl('https://bilivideo.com.evil.test/a'));assert.throws(()=>allowedMediaUrl('http://cdn.bilivideo.com/a'));assert.equal(allowedMediaUrl('https://cdn.bilivideo.com/a').hostname,'cdn.bilivideo.com');});
test('desktop plugin API parses settings before forwarding and retains actionable conflicts',async t=>{
 let cleanup;const box=sandbox({after:fn=>cleanup=fn}),calls=[];
 const service=await startService({dataRoot:path.join(box.root,'chat'),backend:{pluginStatus:()=>[{id:'fish-notebook'}],pluginAction:(id,action,body)=>{calls.push({id,action,body});if(body.revision!==0)throw Error('PLUGIN_SETTINGS_CHANGED');return {...body,revision:1};}}});
 t.after(async()=>{await service.close();cleanup();});const boot=await(await fetch(service.url+'/v1/bootstrap')).json(),headers={'X-Chatagent-Token':boot.token,'Content-Type':'application/json'};
 const response=await fetch(service.url+'/v1/plugins/fish-notebook/settings',{method:'POST',headers,body:JSON.stringify({revision:0,enabled:false})});assert.equal(response.status,200);assert.equal((await response.json()).revision,1);assert.deepEqual(calls[0],{id:'fish-notebook',action:'settings',body:{revision:0,enabled:false}});
 const stale=await fetch(service.url+'/v1/plugins/fish-notebook/settings',{method:'POST',headers,body:JSON.stringify({revision:9})});assert.equal(stale.status,409);assert.equal((await stale.json()).error,'PLUGIN_SETTINGS_CHANGED');
});
