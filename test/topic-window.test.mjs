import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {createChatWindow,recentWindow,estimateWindowTokens} from '../packages/dsh-bridge/chat-window.mjs';
import {initialPreferences} from '../packages/conversation/preferences.mjs';import {sandbox} from './helpers.mjs';
const row=n=>({sourceId:'fixture',scope:'one',id:String(n),kind:'message',role:n%2?'assistant':'user',at:n,text:'消息 '+n+' 当前计划：周六去看鲸鱼，门票尚未确定。'});
test('reply preparation never waits for deferred summaries; idle maintenance remains grounded and cancelled work is not replayed',async t=>{
 const box=sandbox(t),agent=harness(),archive={records:Array.from({length:20},(_,n)=>row(n))};let calls=0,release;
 const policy={recentWindowTokens:2000,recentWindowMessages:20,topicSummaryEnabled:true},window=createChatWindow(agent,()=>archive,{root:box.root,policy:()=>policy,summarize:async(input,signal)=>{calls++;await new Promise(r=>release=r);signal?.throwIfAborted();return {items:[{kind:'open',text:'门票尚未确定',sources:[input.records[0].id]}]};}});
 await window.prepare({allowSummary:false});archive.records.push(row(20));const immediate=await window.prepare({allowSummary:false});assert.equal(calls,0);assert.match(immediate.content[0].text,/门票尚未确定/);
 const controller=new AbortController(),pending=window.maintain(controller.signal);assert.equal(calls,1);controller.abort();release();await pending;assert.equal(window.status().summary.state,'extracts');await window.maintain();assert.equal(calls,1);
 archive.records.push(...Array.from({length:20},(_,n)=>row(n+21)));await window.prepare({allowSummary:false});const next=window.maintain();assert.equal(calls,2);release();await next;assert.equal(window.status().summary.state,'ready');
});
function harness(id='a'){const events=[];return {session:{id,surface:{nodes:[]},snapshotEvents:()=>events},events};}

test('longer windows batch trim, persist grounded summaries and preserve a stable history prefix',async t=>{
 const box=sandbox(t),agent=harness(),archive={records:[]};let calls=0;
 const policy={recentWindowTokens:2000,recentWindowMessages:20,topicSummaryEnabled:true};
 const options={root:box.root,policy:()=>policy,summarize:async data=>{calls++;return {items:[{kind:'open',text:'周六去看鲸鱼，门票尚未确定。',sources:[data.records[0].id]}]};}};
 let window=createChatWindow(agent,()=>archive,options),prior='';
 for(let n=0;n<20;n++){archive.records.push(row(n));const message=await window.prepare();const text=message.content[0].text;if(prior)assert.ok(text.startsWith(prior),'No rolling cutoff or JSON closing bracket changes the history prefix');prior=text;}
 assert.equal(calls,0);archive.records.push(row(20));const cut=await window.prepare();assert.equal(calls,1);assert.match(cut.content[0].text,/门票尚未确定/);assert.ok(window.status().records<20);
 const after=window.status();window=createChatWindow(agent,()=>archive,options);await window.prepare({allowSummary:false});assert.equal(calls,1);assert.equal(window.status().summary.digest,after.summary.digest);assert.equal(window.status().records,after.records);
 const external=createChatWindow(agent,()=>archive,{root:box.root});await external.prepare({allowSummary:false});assert.equal(external.status().recentWindowMessages,20,'Bridge-only callers keep their persisted policy after reload');
 for(let n=21;n<25;n++){archive.records.push(row(n));await window.prepare();}assert.equal(calls,1,'No summary call per ordinary message');
 assert.equal(archive.records.length,25);assert.ok(estimateWindowTokens((await window.prepare()).content[0].text)<4000);
 assert.throws(()=>createChatWindow(harness('other'),()=>archive,options),/CHAT_WINDOW_SESSION_MISMATCH/);
});
test('failed or interrupted summaries retain literal evidence, never replay and honor per-chat opt-out',async t=>{
 const box=sandbox(t),agent=harness(),archive={records:Array.from({length:20},(_,n)=>row(n))};let calls=0;
 const policy={recentWindowTokens:2000,recentWindowMessages:20,topicSummaryEnabled:true},options={root:box.root,policy:()=>policy,summarize:async()=>{calls++;throw Error('synthetic timeout');}};
 let window=createChatWindow(agent,()=>archive,options);await window.prepare();archive.records.push(row(20));const cut=await window.prepare();assert.equal(calls,1);assert.equal(window.status().summary.state,'extracts');assert.match(cut.content[0].text,/门票尚未确定/);
 window=createChatWindow(agent,()=>archive,options);await window.prepare();assert.equal(calls,1);
 const file=path.join(box.root,'chat-window.json'),state=JSON.parse(fs.readFileSync(file));state.attempt.state='running';fs.writeFileSync(file,JSON.stringify(state));window=createChatWindow(agent,()=>archive,options);await window.prepare();assert.equal(calls,1);assert.equal(window.status().summary.attempt,'unknown');
 policy.topicSummaryEnabled=false;archive.records.push(...Array.from({length:25},(_,n)=>row(n+21)));const message=await window.prepare();assert.equal(calls,1);assert.doesNotMatch(message.content[0].text,/话题摘要/);assert.equal(window.status().summary.state,'disabled');
});
test('window policy rejects invalid values; ungrounded summaries fall back without affecting chat history',async()=>{
 for(const policy of [{recentWindowTokens:1999},{recentWindowTokens:64001},{recentWindowMessages:3},{recentWindowMessages:301},{topicSummaryEnabled:'yes'},{recentWindowTokens:null}])assert.throws(()=>initialPreferences({policy}),/INVALID_CHAT_POLICY/);
 assert.equal(initialPreferences().policy.recentWindowMessages,80);
 const agent=harness(),archive={records:Array.from({length:20},(_,n)=>row(n))},policy={recentWindowTokens:2000,recentWindowMessages:20};
 const window=createChatWindow(agent,()=>archive,{policy:()=>policy,summarize:async()=>({items:[{kind:'fact',text:'编造事实',sources:['not-an-archive-id']}]})});await window.prepare();archive.records.push(row(20));const cut=await window.prepare();assert.doesNotMatch(cut.content[0].text,/编造事实/);assert.equal(archive.records.length,21);
 const huge=recentWindow([{id:'big',role:'user',at:0,text:'中文'.repeat(20000)}],[],policy);assert.ok(estimateWindowTokens(JSON.stringify(huge))<=2000);assert.ok(huge[0].truncated);
});
