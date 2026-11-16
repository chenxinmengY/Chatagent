import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createCourseQueryContext} from '../packages/dsh-bridge/course-query-context.mjs';
import {createChatWindow,chatRecords} from '../packages/dsh-bridge/chat-window.mjs';
import {projectChatMessages} from '../packages/dsh-bridge/chat-dispatch.mjs';
import {sandbox} from './helpers.mjs';

const text=value=>[{type:'text',text:value}];
function fixture(){
 const events=[],session={id:'fixture-chat',surface:{nodes:[]},snapshotEvents:()=>events};
 const add=(type,data)=>events.push({seq:events.length,type,time:events.length+1,surfaceOp:'append',data});
 add('turn/start',{turn:0});
 add('user/message',{id:'user',source:{kind:'user',rpcId:'lookup'},content:text('帮我查一下课表 PRIVATE_LOOKUP_REQUEST_524')});
 add('assistant/message',{turn:0,message:{id:'call-message',role:'assistant',content:[{type:'tool-call',id:'lookup-call',name:'course-query__query',arguments:'{}'}]}});
 add('tool/call',{turn:0,name:'course-query__query',callId:'lookup-call'});
 add('tool/result',{turn:0,message:{id:'tool-result',role:'tool',toolCallId:'lookup-call',content:text('PRIVATE_COURSE_ROOM_981')}});
 add('assistant/message',{turn:0,message:{id:'answer',role:'assistant',content:text('PRIVATE_TIMETABLE_ANSWER_782')}});
 return {session,events,add,context:createCourseQueryContext(session)};
}
test('course tool evidence stays live within its turn; same-batch and later memory writes are denied only for that turn',()=>{
 const f=fixture(),before=JSON.stringify(f.events),messages=[f.events[2].data.message,f.events[4].data.message,f.events[5].data.message];
 assert.deepEqual(f.context.project(messages),messages);assert.equal(f.context.permits('remember'),false);
 for(const name of ['course-query__query','daily-reminders__manage','other_tool'])assert.equal(f.context.permits(name),true);
 // The assistant's whole batch is recorded before the first call executes.
 f.events.splice(3);assert.equal(f.context.permits('remember'),false);
 f.add('turn/end',{turn:0,reason:{kind:'completed'}});assert.equal(f.context.permits('remember'),true);
 f.add('turn/start',{turn:1});assert.equal(f.context.permits('remember'),true);
 assert.deepEqual(f.context.project(messages),messages.slice(1),'Only known message IDs are removed');
 assert.ok(before.includes('PRIVATE_COURSE_ROOM_981'));
});
test('query replies cannot return through recent history, automatic recall, archive search or old/pending summaries; raw history and user status survive',async t=>{
 const box=sandbox(t),f=fixture();f.add('turn/end',{turn:0,reason:{kind:'completed'}});
 f.add('turn/start',{turn:1});f.add('user/message',{id:'ordinary-status',source:{kind:'user',rpcId:'status'},content:text('我已经上课了，学校实验做完了')});f.add('turn/end',{turn:1,reason:{kind:'completed'}});
 const original=JSON.stringify(f.events),rows=chatRecords(f.events,f.session.id),answer=rows.find(r=>r.role==='assistant');
 assert.ok(answer);const policy={recentWindowMessages:4,recentWindowTokens:2000,topicSummaryEnabled:true};let calls=0;
 const state={version:2,sessionId:f.session.id,recent:rows,summary:{state:'ready',items:[{kind:'fact',text:answer.text,sources:[answer.id]},{kind:'fact',text:'学校实验已完成',sources:[rows.at(-1).id]}]},pendingSummary:{id:'old',input:{previous:[],records:[answer],recent:[]}},attempt:null,policy};
 const file=path.join(box.root,'chat-window.json');fs.writeFileSync(file,JSON.stringify(state));
 const options={root:box.root,policy:()=>policy,excludedRecordIds:()=>f.context.recordIds(),summarize:async input=>{calls++;assert.doesNotMatch(JSON.stringify(input),/PRIVATE_/);return {items:[{kind:'fact',text:'普通聊天记录',sources:[input.records[0].id]}]};}};
 let window=createChatWindow({session:f.session},()=>null,options);await window.maintain();assert.equal(calls,0);
 const projected=projectChatMessages([await window.prepare({query:'PRIVATE_TIMETABLE_ANSWER_782'})],'PERSONA');
 assert.doesNotMatch(JSON.stringify(projected),/PRIVATE_/);assert.match(JSON.stringify(projected),/我已经上课了|学校实验/);
 assert.doesNotMatch(window.search('PRIVATE_TIMETABLE'),/PRIVATE_TIMETABLE_ANSWER_782/);
 assert.match(window.search('我已经上课了'),/我已经上课了/);
 const saved=JSON.parse(fs.readFileSync(file,'utf8'));assert.ok(!saved.pendingSummary);assert.equal(saved.summary.items.length,1);
 assert.equal(JSON.stringify(f.events),original);assert.ok(chatRecords(f.events,f.session.id).some(r=>r.text===answer.text));
 for(let turn=1;turn<8;turn++){f.add('turn/start',{turn});f.add('user/message',{source:{kind:'user',rpcId:'normal-'+turn},content:text('普通聊天 '+turn)});f.add('assistant/message',{turn,message:{id:'normal-'+turn,role:'assistant',content:text('普通回答 '+turn)}});f.add('turn/end',{turn,reason:{kind:'completed'}});await window.prepare({query:'PRIVATE_TIMETABLE'});}
 assert.ok(calls>0);window=createChatWindow({session:f.session},()=>null,options);
 assert.doesNotMatch(JSON.stringify(await window.prepare({query:'PRIVATE_TIMETABLE'})),/PRIVATE_/);
 assert.match(window.search('普通回答'),/普通回答/);
});
test('completed native tool chains are omitted at dispatch, while current inputs, other tools and source events stay unchanged',()=>{
 const f=fixture(),messages=[{id:'ordinary',role:'assistant',content:text('我也喜欢这门课程')},f.events[2].data.message,f.events[4].data.message,f.events[5].data.message,{id:'current',role:'user',content:text('学校真热')},f.events[1].data],before=JSON.stringify(messages);
 f.add('turn/end',{turn:0,reason:{kind:'cancelled'}});
 assert.deepEqual(f.context.project(messages),[messages[0],messages[4]]);assert.equal(JSON.stringify(messages),before);
 assert.deepEqual(f.context.requestIds(),['lookup']);
 const history=[{role:'assistant',contextParent:'lookup',text:'query reply'},{id:'lookup',role:'user',text:'帮我查一下课表'},{id:'normal-status',role:'user',text:'我已经上课了'},{role:'assistant',contextParent:'unrelated',text:'normal'}];
 assert.deepEqual(f.context.filterHistory(history),history.slice(2));
});
test('course query access follows the current request; greetings and ordinary school conversation do not authorize a fresh lookup',()=>{
 const f=fixture();f.add('turn/end',{turn:0,reason:{kind:'completed'}});
 for(const request of ['萌萌明天我有什么课','帮我看看课表','明天有课吗','下节是什么课','查一下今天上课时间','今天呢','再查一次'])assert.equal(f.context.requestsQuery(request),true,request);
 for(const request of ['早','课间呢','我已经上课了','学校实验做完了','今天上课好累','陪我说说话','抱抱小鲸鱼'])assert.equal(f.context.requestsQuery(request),false,request);
 f.add('turn/start',{turn:1});f.add('user/message',{source:{kind:'user',rpcId:'normal'},content:text('早')});f.add('turn/end',{turn:1,reason:{kind:'completed'}});
 assert.equal(f.context.requestsQuery('今天呢'),false,'An unrelated chat ends an implicit lookup follow-up');
 assert.equal(f.context.requestsQuery('萌萌明天我有什么课'),true);
});
test('an old unrequested lookup excludes its answer without erasing the user greeting or ordinary current status',()=>{
 const f=fixture();f.add('turn/end',{turn:0,reason:{kind:'completed'}});f.add('turn/start',{turn:1});
 f.add('user/message',{id:'break',source:{kind:'user',rpcId:'break'},content:text('课间呢')});f.add('tool/call',{turn:1,name:'course-query__query'});f.add('assistant/message',{turn:1,message:{id:'bad-answer',role:'assistant',content:text('PRIVATE_UNREQUESTED_ANSWER')}});f.add('turn/end',{turn:1,reason:{kind:'completed'}});
 assert.ok(f.context.requestIds().includes('break'));assert.ok(!f.context.userRequestIds().includes('break'));
 assert.equal(f.context.requestsQuery('今天呢'),false,'An unsolicited model lookup cannot authorize a follow-up');
 const input=f.events.find(e=>e.data.id==='break').data;assert.deepEqual(f.context.project([input,f.events.at(-2).data.message]),[input]);
 const history=[{id:'break',role:'user',text:'课间呢'},{role:'assistant',contextParent:'break',text:'PRIVATE_UNREQUESTED_ANSWER'}];assert.deepEqual(f.context.filterHistory(history),history.slice(0,1));
});
