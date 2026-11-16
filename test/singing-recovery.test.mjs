import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {sandbox} from './helpers.mjs';
import {parseInvitation} from '../packages/companion-capabilities/vendor/singing/intent.mjs';
import {createSingingService} from '../packages/companion-capabilities/vendor/singing/service.mjs';
import {singingReply,singingAttempt} from '../packages/dsh-bridge/local-singing.mjs';

const bvid='BV1Vb57ztE37',at=1794541714174;
const row=(text,id='message',time=at)=>({platform:'wechat',kind:'private',conversation_id:'12345',message_id:id,text,timestamp:time/1000,outgoing:false});
const scope={sessionId:'test-session',conversationKey:'wechat:private:12345'};

test('补发BV号和B站链接接续待选邀请，并保留片段范围',()=>{
 const pending=parseInvitation(row('想听你唱老男孩 5:00到5:06','invite'),{now:at});
 assert.equal(pending.needsSelection,true);assert.equal(pending.end,306);
 for(const text of [bvid,'就是这首啦'+bvid,'这首 '+bvid,'https://www.bilibili.com/video/'+bvid+'/?share_source=copy_web']){
  const selected=parseInvitation(row(text,'selection',at+30000),{pending,now:at+30000});
  assert.deepEqual(selected,{...pending,bvid,needsSelection:false,messageId:'selection',createdAt:at+30000});
 }
 assert.equal(parseInvitation(row('想听你唱 '+bvid+' 前10分钟'),{now:at}).end,600);
 assert.equal(parseInvitation(row('想听你唱 '+bvid+' 前601秒'),{now:at}).reason,'clip_range');
});

test('无邀请、过期、引用、否定、提问和多个BV号不能补成点唱',()=>{
 const pending=parseInvitation(row('想听你唱老男孩','invite'),{now:at});
 assert.equal(parseInvitation(row(bvid),{now:at}),null);
 assert.equal(parseInvitation(row(bvid,'later',at+300001),{pending,now:at+300001}),null);
 for(const text of ['“'+bvid+'”','不要 '+bvid,bvid+'好听吗',bvid+' BV1xx411c7mD','如果是'+bvid])assert.equal(parseInvitation(row(text),{pending,now:at}),null,text);
 for(const changes of [{outgoing:true},{quoteReply:{}},{forwardedRecord:{}}])assert.equal(parseInvitation({...row(bvid),...changes},{pending,now:at}),null);
 assert.equal(parseInvitation(row(bvid),{pending:{...pending,reason:'clip_range'},now:at}),null);
});

function fixture(t){
 let cleanup;const box=sandbox({after:fn=>cleanup=fn}),notices=[],history=[];let time=at,resolves=0;
 const service=createSingingService({directory:path.join(box.root,'singing'),scope,allowed:()=>true,now:()=>time,rows:()=>history,recipeDigest:'test',worker:{ready:true,state:'ready',close:async()=>{}},source:{resolve:async()=>{resolves++;throw Error('SINGING_SOURCE_DURATION_LIMIT');}},transport:{},notification:{isReady:()=>true,withLock:(_key,fn)=>fn(),send:async notice=>{notices.push(notice);return {confirmed:true,delivered:'database-confirmed'};}}});
 t.after(async()=>{await service.close();cleanup();});
 return {service,notices,receive(text,id,extra={}){const message={...row(text,id,time),...extra};history.push(message);service.receive(message);},advance(ms){time+=ms;},get resolves(){return resolves;}};
}

test('跨轮补发只启动一次任务，失败原因进入状态与通知且覆盖错误的准备中回复',async t=>{
 const f=fixture(t);f.receive('想听你唱老男孩','invite');
 assert.equal((await f.service.control({...scope,action:'context'})).status,'needs_selection');
 f.advance(30000);f.receive('就是这首啦'+bvid,'selection');
 const context=await f.service.control({...scope,action:'context'});assert.equal(context.invitation.bvid,bvid);
 assert.equal((await f.service.control({...scope,action:'sing',inviteId:context.inviteId})).status,'submitted');
 await f.service.settled();
 const status=await f.service.control({...scope,action:'status'});assert.equal(status.job.errorCode,'SINGING_SOURCE_DURATION_LIMIT');assert.match(status.job.errorMessage,/10分钟/);
 assert.equal(f.notices.length,1);assert.match(f.notices[0].text,/原因：原曲超过10分钟/);
 const snapshot=f.service.snapshot();assert.equal(singingReply(snapshot,'正在准备，稍后发给你','selection'),f.notices[0].text);
 assert.equal(singingReply(snapshot,'其他聊天内容','other'),'其他聊天内容');
 await f.service.tick();assert.equal(f.notices.length,1);
 f.receive('就是这首啦'+bvid,'selection');
 const duplicate=await f.service.control({...scope,action:'context'});assert.equal(duplicate.inviteId,null);assert.equal(f.resolves,1);
});

test('取消、无关新消息、过期及跨聊天BV号都不能接续旧邀请',async t=>{
 for(const action of ['cancel','unrelated','expired','other-chat']){
  const f=fixture(t);f.receive('想听你唱老男孩','invite');
  if(action==='cancel')f.receive('停止唱歌','stop');
  if(action==='unrelated')f.receive('我先去吃饭','unrelated');
  if(action==='expired')f.advance(300001);
  f.receive(bvid,'selection',action==='other-chat'?{conversation_id:'67890'}:{});
  const context=await f.service.control({...scope,action:'context'});
  if(action==='other-chat')assert.equal(context.invitation.needsSelection,true);
  else assert.equal(context.inviteId,null);
  assert.equal(f.resolves,0);
 }
});

test('结果未知保留未知提示，不错误宣称没发送或继续准备',()=>{
 const snapshot={jobs:[{request:{messageId:'one'},status:'unknown',failureNotice:{text:'发送结果未确认，不会自动补发'}}]};
 assert.equal(singingReply(snapshot,'稍后给你','one'),'发送结果未确认，不会自动补发');
 assert.equal(singingReply({jobs:[{request:{messageId:'one'},status:'making'}]},'制作中','one'),'制作中');
});

test('真实失败后的自然说法可新建点唱，不能把旧错误当成这次失败',async t=>{
 const f=fixture(t);f.receive('想听你唱 '+bvid,'old-request');
 const first=await f.service.control({...scope,action:'context'});await f.service.control({...scope,action:'sing',inviteId:first.inviteId});await f.service.settled();
 const old=f.service.snapshot().jobs[0];f.advance(35*60000);
 f.receive('萌萌我想听'+bvid,'actual-user-wording');
 const context=await f.service.control({...scope,action:'context'});assert.equal(context.invitation.messageId,'actual-user-wording');assert.equal(context.invitation.bvid,bvid);
 assert.equal((await f.service.control({...scope,action:'sing',inviteId:context.inviteId})).status,'submitted');await f.service.settled();
 const jobs=f.service.snapshot().jobs;assert.equal(jobs.length,2);assert.equal(jobs[1].request.messageId,'actual-user-wording');assert.deepEqual(jobs[0],old);assert.equal(f.resolves,2);
});

test('省略唱字需要已点唱的同一首歌或待选邀请，听原唱与普通分享不触发',()=>{
 const previousRequest=parseInvitation(row('想听你唱 '+bvid+' 前25秒'),{now:at});
 assert.equal(parseInvitation(row('萌萌我想听'+bvid),{now:at}),null);
 const again=parseInvitation(row('萌萌我想听'+bvid,'again',at+3600000),{previousRequest,now:at+3600000});assert.equal(again.mode,'clip');assert.equal(again.end,25);
 for(const text of ['我想听'+bvid+'原唱','我想听'+bvid+'吗','我想听原曲'+bvid,'如果我想听'+bvid,'我想听 BV1xx411c7mD'])assert.equal(parseInvitation(row(text),{previousRequest,now:at}),null,text);
 const pending=parseInvitation(row('想听你唱老男孩','pending'),{now:at});assert.equal(parseInvitation(row('萌萌我想听'+bvid),{pending,now:at}).bvid,bvid);
 for(const text of ['萌萌我想听'+bvid+' 前20秒','萌萌我想听你唱'+bvid+' 前20秒'])assert.equal(parseInvitation(row(text),{previousRequest,now:at}).end,20);
});

test('按本轮原生工具回执纠正未启动提示，不能串用其他轮次或旧失败',()=>{
 const events=[
  {seq:1,type:'turn/start',data:{turn:1}},
  {seq:2,type:'user/message',data:{source:{rpcId:'current'}}},
  {seq:3,type:'tool/call',data:{turn:1,callId:'call-status',name:'chatagent_singing__control',arguments:'{"action":"status"}'}},
  {seq:4,type:'tool/result',data:{turn:1,message:{toolCallId:'call-status',content:[{type:'text',text:'{"status":"error"}'}]}}},
  {seq:5,type:'tool/call',data:{turn:1,callId:'call-sing',name:'chatagent_singing__control',arguments:'{"action":"sing"}'}},
  {seq:6,type:'tool/result',data:{turn:1,message:{toolCallId:'call-sing',content:[{type:'text',text:'{"status":"needs_invitation"}'}]}}},
  {seq:7,type:'turn/end',data:{turn:1}},
  {seq:8,type:'turn/start',data:{turn:2}},
  {seq:9,type:'user/message',data:{source:{rpcId:'other'}}},
  {seq:10,type:'tool/call',data:{turn:2,callId:'next-sing',name:'chatagent_singing__control',arguments:'{"action":"sing"}'}},
  {seq:11,type:'tool/result',data:{turn:2,message:{source:{callId:'next-sing'},content:[{type:'text',text:'{"status":"submitted"}'}]}}}
 ];
 const attempt=singingAttempt(events,'current');assert.equal(attempt.status,'needs_invitation');assert.equal(singingAttempt(events,'other').status,'submitted');assert.equal(singingAttempt(events,'absent'),null);
 const snapshot={jobs:[{request:{messageId:'old'},status:'error',failureNotice:{text:'旧任务取原曲失败'}}]};
 assert.match(singingReply(snapshot,'我又试了一次，取原曲失败','current',attempt),/这次没有启动翻唱任务/);
 assert.equal(singingReply(snapshot,'正常聊天','other',singingAttempt(events,'other')),'正常聊天');
 for(const status of ['needs_selection','worker_preparing','unavailable','busy'])assert.notEqual(singingReply(snapshot,'原曲失败','current',{status}),'原曲失败');
});
