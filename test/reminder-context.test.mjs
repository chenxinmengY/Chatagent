import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createReminderContext,projectReminderHistory} from '../packages/dsh-bridge/reminder-context.mjs';
import {createChatWindow} from '../packages/dsh-bridge/chat-window.mjs';
import {ReminderStore} from '../packages/local-user-plugins/plugins/daily-reminders/lib/store.mjs';
import {ReminderScheduler} from '../packages/local-user-plugins/plugins/daily-reminders/lib/scheduler.mjs';

test('real reminder batches are read-only projected by schedule, preserving one-off reminders and ordinary conversation',async()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'chatagent-reminder-policy-')),root=path.join(base,'plugins'),account='a'.repeat(64),key='wechat:private:1',session={id:'isolated',snapshotEvents:()=>[]};
 fs.mkdirSync(root);fs.writeFileSync(path.join(root,'chatagent-binding.json'),JSON.stringify({sessionId:session.id,account,key}));
 const store=new ReminderStore(root,account),chatFile=path.join(base,'chat.sqlite'),chat=new DatabaseSync(chatFile);
 chat.exec('CREATE TABLE messages(id TEXT,client_id TEXT,device TEXT)');
 let now=Date.parse('2030-01-01T12:00:00+08:00');const daily=store.manage(key,{action:'create',repeat:'daily',time:'12:01',text:'RECURRING_DAILY',phrase:'RECURRING_DAILY'},now),once=store.manage(key,{action:'create',repeat:'once',delayMinutes:1,text:'ONCE_MEETING',phrase:'ONCE_MEETING'},now);
 const weekly=store.manage(key,{action:'create',repeat:'weekly',time:'12:02',weekdays:[1,2,3,4,5,6,7],text:'RECURRING_WEEKLY',phrase:'RECURRING_WEEKLY'},now);
 const sent=[];const scheduler=new ReminderScheduler({store,now:()=>now,allowed:()=>true,ready:()=>true,send:batch=>{sent.push(batch);chat.prepare('INSERT INTO messages VALUES(?,?,?)').run('receipt-'+sent.length,'reminder-'+batch.id,'plugin-delivery');return {confirmed:true,delivered:'database-confirmed'};}});
 try{
  now+=60000;await scheduler.tick();now+=60000;await scheduler.tick();assert.equal(sent.length,2);assert.match(sent[0].text,/RECURRING_DAILY/);assert.match(sent[0].text,/ONCE_MEETING/);
  const imported=[{kind:'message',sourceId:'legacy',scope:key,id:'old-mixed',role:'assistant',text:sent[0].text},{kind:'message',sourceId:'legacy',scope:key,id:'ordinary',role:'user',text:'  我每天跑步，今天校园跑已经完成了  '}];
  const policy=createReminderContext(session,{root,chatFile,imported:()=>imported});
  const auditEvents=[{seq:1,type:'turn/start',data:{turn:7}},{seq:2,type:'user/message',data:{id:'list-user',source:{kind:'user',rpcId:'list-request'},content:[{type:'text',text:'只列一次性提醒'}]}},{seq:3,type:'tool/call',data:{turn:7,name:'daily-reminders__manage',callId:'list-call',arguments:JSON.stringify({action:'list',kind:'once'})}},{seq:4,type:'tool/result',data:{turn:7,message:{toolCallId:'list-call',content:[{type:'text',text:JSON.stringify({text:JSON.stringify(store.manage(key,{action:'list',kind:'once'},now))})}]}}},{seq:5,type:'turn/end',data:{turn:7}}];
  assert.ok(createReminderContext({...session,snapshotEvents:()=>auditEvents},{root,chatFile}).status().excludedRequestIds.includes('list-request'),'A once-only list may carry recent recurring occurrences; those results cannot become future chat facts');
  const history=[...sent.map((batch,i)=>({id:'receipt-'+(i+1),role:'assistant',text:batch.text})),{id:'personal',role:'user',text:'今天校园跑已经完成了'},{id:'once',role:'user',text:'明天下午提醒我见老师'}];
  const before=JSON.stringify({plans:store.plans(key),batches:store.all('SELECT * FROM batches'),occurrences:store.all('SELECT * FROM occurrences')}),view=policy.filterHistory(history);
  assert.doesNotMatch(JSON.stringify(view),/RECURRING_DAILY|RECURRING_WEEKLY/);assert.match(JSON.stringify(view),/ONCE_MEETING|明天下午提醒我见老师|今天校园跑已经完成了/);assert.equal(view.length,3);
  assert.deepEqual(projectReminderHistory(history,policy.status()),view);
  const rows=imported.map(row=>({...row,id:JSON.stringify([row.sourceId,row.scope,row.id])})),context=policy.records(rows);assert.match(context[0].text,/ONCE_MEETING/);assert.doesNotMatch(context[0].text,/RECURRING/);assert.equal(context[1].text,imported[1].text);assert.ok(context[0].id.startsWith('reminder-once:'));
  store.manage(key,{action:'cancel',planId:daily.plan.id},now);store.manage(key,{action:'cancel',planId:weekly.plan.id},now);
  assert.doesNotMatch(JSON.stringify(createReminderContext(session,{root,chatFile}).filterHistory(history)),/RECURRING/,'Cancellation does not reintroduce old notifications');
  assert.equal(store.plans(key).find(p=>p.id===Number(once.plan.id.slice(1))).state,'completed');
  assert.notEqual(JSON.stringify(store.plans(key)),before,'Explicit test cancellations changed fixture state only');
  assert.equal(JSON.stringify({batches:store.all('SELECT * FROM batches'),occurrences:store.all('SELECT * FROM occurrences')}),JSON.stringify((({batches,occurrences})=>({batches,occurrences}))(JSON.parse(before))));
  assert.throws(()=>createReminderContext({...session,id:'another-chat'},{root}),/SESSION_MISMATCH/);
 }finally{chat.close();await scheduler.close();assert.equal(path.dirname(fs.realpathSync(base)),fs.realpathSync(os.tmpdir()));fs.rmSync(base,{recursive:true});}
});

test('native reminder provenance isolates completed turns, blocks parallel memory, and reconciles saved summaries',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chatagent-reminder-window-')),events=[],session={id:'isolated-window',surface:{nodes:[]},snapshotEvents:()=>events};let seq=0;
 const add=(type,data)=>events.push({seq:++seq,type,surfaceOp:'append',time:seq,data}),message=(id,text)=>({id,role:'assistant',content:[{type:'text',text}]});
 add('turn/start',{turn:1});add('user/message',{id:'u1',turn:1,source:{kind:'user',rpcId:'r1'},content:[{type:'text',text:'每天提醒我 REPEAT_SECRET'}]});
 const context=createReminderContext(session);
 assert.equal(context.permits('remember'),false,'Memory is blocked before a parallel reminder tool executes');
 add('tool/call',{turn:1,callId:'c1',name:'daily-reminders__manage',arguments:JSON.stringify({action:'create',repeat:'daily'})});
 add('tool/result',{turn:1,message:{...message('t1',JSON.stringify({text:JSON.stringify({plan:{id:'R01',schedule:{kind:'daily'}}})})),role:'tool',toolCallId:'c1'}});
 add('assistant/message',{turn:1,message:message('a1','REPEAT_SECRET 已设置')});
 assert.equal(context.project([events[1].data,events[3].data.message,events[4].data.message]).length,3,'Live management can read the requested plan');
 add('turn/end',{turn:1,reason:{kind:'completed'}});
 assert.equal(context.project([events[1].data,events[3].data.message,events[4].data.message]).length,0);
 assert.equal(context.permits('remember'),true);
 const excluded='native:'+session.id+':'+events[4].seq;
 add('turn/start',{turn:2});add('user/message',{id:'u2',turn:2,source:{kind:'user',rpcId:'r2'},content:[{type:'text',text:'明天下午提醒我 ONCE_SECRET'}]});
 add('tool/call',{turn:2,callId:'c2',name:'daily-reminders__manage',arguments:JSON.stringify({action:'create',repeat:'once'})});
 add('assistant/message',{turn:2,message:message('a2','ONCE_SECRET 已安排')});add('turn/end',{turn:2,reason:{kind:'completed'}});
 assert.equal(context.permits('remember'),true);assert.equal(context.project([message('a2','ONCE_SECRET')]).length,1);
 add('turn/start',{turn:3});add('user/message',{id:'u3',turn:3,source:{kind:'user',rpcId:'r3'},content:[{type:'text',text:'我每天跑步，今天校园跑完成了'}]});add('assistant/message',{turn:3,message:message('a3','好')});add('turn/end',{turn:3,reason:{kind:'completed'}});
 const saved={version:2,sessionId:session.id,recent:[{id:excluded,role:'assistant',text:'REPEAT_SECRET',at:1}],summary:{state:'ready',items:[{kind:'fact',text:'REPEAT_SECRET',sources:[excluded]}]},pendingSummary:{id:'old',input:{records:[{id:excluded,text:'REPEAT_SECRET'}],recent:[],previous:[]}},policy:{recentWindowMessages:8,recentWindowTokens:2000,topicSummaryEnabled:true}};
 fs.writeFileSync(path.join(dir,'chat-window.json'),JSON.stringify(saved));
 try{
  const window=createChatWindow({session},()=>({records:[]}),{root:dir,excludedRecordIds:context.recordIds,projectRecords:context.records});
  const prepared=await window.prepare(),search=window.search('REPEAT_SECRET');assert.doesNotMatch(JSON.stringify(prepared),/REPEAT_SECRET/);assert.match(JSON.stringify(prepared),/ONCE_SECRET/);assert.match(JSON.stringify(prepared),/今天校园跑完成了/);assert.doesNotMatch(search,/REPEAT_SECRET/);
  const next=JSON.parse(fs.readFileSync(path.join(dir,'chat-window.json'),'utf8'));assert.equal(next.pendingSummary,undefined);assert.deepEqual(next.summary.items,[]);assert.ok(events.some(e=>JSON.stringify(e).includes('REPEAT_SECRET')),'Original event archive remains intact');
 }finally{assert.equal(path.dirname(fs.realpathSync(dir)),fs.realpathSync(os.tmpdir()));fs.rmSync(dir,{recursive:true});}
});

test('audited legacy fragments are removed only from the specified records',()=>{
 const session={id:'legacy',snapshotEvents:()=>[]},context=createReminderContext(session,{exclusions:{sessionId:session.id,reminderRedactions:[{id:'mixed',remove:['重复提醒污染。']},{id:'diary:today',remove:['重复提醒污染。']}]}});
 const rows=context.records([{id:'mixed',role:'user',text:'正常聊天。重复提醒污染。明天见老师。'},{id:'other',role:'user',text:'重复提醒污染。用户主动聊到相同主题'}]);
 assert.equal(rows[0].text,'正常聊天。明天见老师。');assert.equal(rows[1].text,'重复提醒污染。用户主动聊到相同主题');assert.equal(context.diaryText({id:'today'},'正常聊天。重复提醒污染。'),'正常聊天。');assert.equal(context.diaryText({id:'another'},'重复提醒污染。'),'重复提醒污染。');
});
