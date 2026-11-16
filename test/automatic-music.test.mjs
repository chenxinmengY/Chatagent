import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {sandbox} from './helpers.mjs';import {automaticMusic} from '../packages/dsh-bridge/automatic-music.mjs';
test('autonomous music honors permission and quotas, records only observed audio, and does not replay an interrupted task',async t=>{
 const {root}=sandbox(t);let allowed=false,calls=0,reservations=0,feelings=0,clock=100000,started=0;
 const options={root,now:()=>clock,enabled:()=>allowed,busy:()=>false,lastChat:()=>clock-1000,policy:()=>({dailyRounds:5,dailyMinutes:25,roundMinutes:5}),due:(_p,s)=>s.now-s.lastStart>=1000,book:{usage:()=>({times:[],rounds:[],attempts:[],pendingMusic:0}),reserveRound(){reservations++;started=clock;},finishRound(){},setOutcome(){},experiences:()=>[{id:'observation',bvid:'BV1rDx46VENg',at:new Date(started).toISOString(),feeling:''}],setFeeling(){feelings++;},markFeeling(){}},candidates:async()=>[{bvid:'BV1rDx46VENg'}],generate:async({maxTokens})=>maxTokens===2048?'BV1rDx46VENg':'依据音频的感受',persona:()=>'',listen:async()=>{calls++;return {status:'observed',material:{description:'合成音频证据'}};}};
 let runner=automaticMusic(options);clock+=2000;await runner.tick();assert.equal(calls,0);allowed=true;await runner.tick();assert.equal(calls,1);assert.equal(feelings,1);await runner.tick();assert.equal(reservations,1);await runner.close();
 fs.writeFileSync(path.join(root,'automatic-music.json'),JSON.stringify({lastStart:clock,phase:'listening',seen:[],id:'interrupted'}));runner=automaticMusic(options);assert.equal(runner.status().phase,'unknown');await runner.tick();assert.equal(calls,1);await runner.close();
});
test('unavailable listening interface blocks selection, quota reservation and network before automatic music begins',async t=>{
 const {root}=sandbox(t);const no=()=>assert.fail('unconfigured audio must not spend or reserve');const runner=automaticMusic({root,ready:()=>false,busy:()=>false,enabled:()=>true,policy:no,due:no,book:{reserveRound:no},candidates:no,generate:no,listen:no});t.after(()=>runner.close());await runner.tick();assert.equal(runner.status().phase,'idle');
});
test('busy checks can inspect music activity without evaluating scheduling recursively',async t=>{
 const {root}=sandbox(t);let probes=0,runner;runner=automaticMusic({root,enabled:()=>true,ready:()=>true,busy:()=>{probes++;return runner.isRunning();},policy:()=>({enabled:true,dailyRounds:5,dailyMinutes:25}),book:{usage:()=>({times:[],rounds:[],attempts:[],pendingMusic:0})},due:()=>false,lastChat:()=>0});
 try{assert.equal(runner.status().schedule.reason,'waiting-schedule');assert.equal(probes,1);assert.equal(runner.isRunning(),false);assert.equal(probes,1);}finally{await runner.close();}
});
test('automatic selection excludes historical audio attempts as well as its own seen list',async t=>{
 const {root}=sandbox(t);let listened=0,generated=0;const outcomes=[];
 const runner=automaticMusic({root,enabled:()=>true,ready:()=>true,busy:()=>false,due:()=>true,lastChat:()=>0,policy:()=>({enabled:true,dailyRounds:5,dailyMinutes:25,roundMinutes:5}),
  book:{usage:()=>({times:[],rounds:[],attempts:[],pendingMusic:0}),reserveRound(){},setOutcome:(id,value)=>outcomes.push(value),finishRound(){}},
  excluded:()=>['BV1rDx46VENg'],candidates:async()=>[{bvid:'BV1rDx46VENg',title:'previously not music'},{bvid:'BV1ky421i7dL',title:'new synthetic song'}],
  generate:async({prompt})=>{generated++;assert.ok(!prompt.includes('previously not music'));return 'BV1ky421i7dL';},persona:()=>'',listen:async()=>{listened++;return {status:'not_music'};}});
 try{await runner.tick();assert.equal(generated,1);assert.equal(listened,1);assert.equal(outcomes.at(-1).status,'not_music');assert.match(outcomes.at(-1).reason,/未计.*成功/);}finally{await runner.close();}
});
