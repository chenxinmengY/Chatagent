import test from 'node:test';
import assert from 'node:assert/strict';
import {chatRecords,recentWindow,searchHistory} from '../packages/dsh-bridge/chat-window.mjs';

const row=(id,text='message '+id)=>({id:String(id),role:id%2?'user':'assistant',at:id,text});
test('聊天窗口按各聊天的消息和估算token预算批量裁剪',()=>{
 const rows=Array.from({length:20},(_,n)=>row(n+1));
 const policy={recentWindowMessages:8,recentWindowTokens:2000};
 const a=recentWindow(rows.slice(0,8),[],policy);assert.equal(a.length,8);
 const b=recentWindow(rows.slice(0,12),a,policy);assert.equal(b.length,5);assert.equal(b[0].id,'8');
 const c=recentWindow(rows,b,policy);assert.equal(c.length,5);assert.equal(c[0].id,'16');
 const changed=rows.map(r=>r.id==='5'?{...r,text:'edited'}:r);assert.equal(recentWindow(changed.slice(0,12),a,policy).length,8);
 const huge=recentWindow([row(1,'x'.repeat(12000))],[],policy);assert.ok(huge[0].text.length<8000);assert.equal(huge[0].truncated,true);
 assert.equal(rows[0].text,'message 1');
});
test('完整历史来自原始双方消息，不收录快照、工具草稿、未知结果或窗口替换副本',()=>{
 const events=[{seq:0,type:'turn/start',data:{turn:0}},
  {seq:1,type:'user/message',surfaceOp:'append',time:10,data:{source:{kind:'user',rpcId:'r'},content:[{type:'text',text:'new question'}]}},
  {seq:2,type:'user/message',surfaceOp:'append',data:{source:{kind:'runtime-context'},content:[{type:'text',text:'context secret'}]}},
  {seq:3,type:'assistant/message',surfaceOp:'append',data:{turn:0,message:{toolCalls:[{}],content:[{type:'text',text:'tool draft'}]}}},
  {seq:4,type:'assistant/message',surfaceOp:'append',time:11,data:{turn:0,message:{content:[{type:'text',text:'final answer'}]}}},
  {seq:5,type:'turn/end',data:{turn:0,reason:{kind:'completed'}}},
  {seq:6,type:'user/message',surfaceOp:{op:'replace',startSeq:1,endSeq:4},data:{source:{kind:'chatagent-window'},content:[{type:'text',text:'window copy'}]}},
  {seq:7,type:'assistant/message',surfaceOp:'append',data:{turn:1,message:{content:[{type:'text',text:'unknown answer'}]}}}];
 const rows=chatRecords(events,'a',[{...row(0,'old archive'),kind:'message'}]);
 assert.deepEqual(rows.map(r=>r.text),['old archive','new question','final answer']);
 assert.match(searchHistory(rows,'answer'),/final answer/);assert.doesNotMatch(searchHistory(rows,'secret'),/context secret/);
 assert.ok(searchHistory([row(1,'long'.repeat(10000))],'long').length<=8000);
 const escaped=searchHistory(Array.from({length:8},(_,n)=>row(n,'"'.repeat(10000))),'"');assert.ok(escaped.length<=8000);assert.ok(JSON.parse(escaped).matches.length);
 assert.deepEqual(chatRecords(events,'b',[]).map(r=>r.id),['native:b:1','native:b:4']);
});
