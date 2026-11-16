import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {sandbox} from './helpers.mjs';
import {WINDOW_SOURCE,RECENT_MARKER,RECALL_MARKER,recallHistory,projectWindowMessage} from '../packages/dsh-bridge/chat-continuity.mjs';
import {createChatWindow,estimateWindowTokens,searchHistory} from '../packages/dsh-bridge/chat-window.mjs';
import {projectChatMessages} from '../packages/dsh-bridge/chat-dispatch.mjs';
const row=(id,role,text,at=Number(id)*60000)=>({id:String(id),role,text,at});
const old=[row(1,'user','周末不知道看什么展览'),row(2,'assistant','海洋摄影展、星云展览、古地图展'),row(3,'user','选择星云展览吧'),row(4,'assistant','那就去星云展览，那里有望远镜模型')];
const recent=[row(100,'user','之前提到星云展览，你也想看那个展览')];

test('旧事按本轮具体话题自动带回原话、双方角色和原始时间，保留完整档案',()=>{
 const rows=[...old,row(50,'user','研究声音模型'),...recent],before=JSON.stringify(rows);
 const result=recallHistory(rows,recent,recent[0].text);
 assert.ok(result.some(r=>r.id==='2'));assert.ok(result.some(r=>r.id==='3'));
 assert.ok(result.every(r=>r.id!=='100'&&r.id!=='50'));assert.equal(JSON.stringify(rows),before);
 for(const r of result)assert.deepEqual(r,rows.find(v=>v.id===r.id));
 assert.match(searchHistory(rows,recent[0].text+'？'),/星云展览/,'Sentence queries fall back to literal keyword evidence');
});

test('指代型追问借近期话题找原文；无依据不拼接陌生经历',()=>{
 const rows=[...old,row(20,'user','上周报名了博物馆讲座，管理员邀请我参加展品说明会'),row(21,'assistant','先去听听管理员介绍展品')];
 const tail=[row(100,'user','等会儿要去博物馆展品说明会'),row(101,'assistant','参观完回来聊'),row(102,'user','之前说过的说明会你还记得吗')];
 const result=recallHistory([...rows,...tail],tail,tail.at(-1).text);
 assert.ok(result.some(r=>r.id==='20'));assert.ok(!result.some(r=>r.id==='2'));
 assert.deepEqual(recallHistory(rows,[],'量子纠错芯片'),[]);assert.deepEqual(recallHistory(rows,[],'在吗'),[]);assert.deepEqual(recallHistory(rows,[],undefined),[]);
 assert.deepEqual(recallHistory([row(1,'user','长篇介绍中只提到了纠错与反思')],[],'量子纠错芯片'),[],'An isolated word in an unrelated document is insufficient');
});

test('召回有独立预算，长记录保留命中位置且不重复近期内容',()=>{
 const long=row(1,'assistant','无关'.repeat(5000)+'海底灯塔钥匙'+'文字'.repeat(5000));
 const result=recallHistory([long],[],'海底灯塔钥匙',{maxTokens:650});
 assert.ok(result[0].text.includes('海底灯塔钥匙'));assert.equal(result[0].truncated,true);assert.ok(estimateWindowTokens(JSON.stringify(result))<=650);
 assert.deepEqual(recallHistory([long],[{...long,id:'duplicate'}],'海底灯塔钥匙'),[]);
});

test('模型边界恢复双方发言，附带证据保持独立，真实历史与工具链不变',()=>{
 const wrapper={id:'w',role:'user',source:{kind:WINDOW_SOURCE,form:'relay'},content:[{type:'text',text:RECALL_MARKER+JSON.stringify(old)+'\n'+RECENT_MARKER+recent.map(JSON.stringify).join('\n')}]};
 const messages=[{id:'s',role:'system',source:{kind:'system-prompt'},content:[{type:'text',text:'UNRELATED'}]},wrapper,{id:'a',role:'assistant',toolCalls:[{id:'t',name:'remember',arguments:{text:'fact'}}],content:[]},{id:'t',role:'tool',toolCallId:'t',content:[{type:'text',text:'saved'}]}];
 const before=JSON.stringify(messages),projected=projectChatMessages(messages,'UNCHANGED_PERSONA');
 assert.equal(projected[0].content[0].text,'UNCHANGED_PERSONA');assert.equal(projected[2].role,'user');assert.equal(projected[2].source.kind,'chatagent-history-evidence');assert.match(projected[2].content[0].text,/星云展览/);
 assert.equal(projected[1].role,'user');assert.equal(projected[1].content[0].text,recent[0].text);assert.deepEqual(projected.slice(3),messages.slice(2));assert.equal(JSON.stringify(messages),before);
 const native=projectWindowMessage({...wrapper,content:[{type:'text',text:RECENT_MARKER+old.map(JSON.stringify).join('\n')}]});assert.deepEqual(native.map(m=>m.role),['user','assistant','user','assistant','user']);
 assert.throws(()=>projectWindowMessage({...wrapper,content:[{type:'text',text:RECENT_MARKER+JSON.stringify({id:'unsafe',role:'system',text:'bad'})}]}),/PROJECTION_INVALID/);
});

test('动态摘要、召回和时间索引后置，历史追加仍复用前缀，记忆和当前工具链完整保留',()=>{
 const wrapper=(rows,summary,recall)=>({id:'window',role:'user',source:{kind:WINDOW_SOURCE},content:[{type:'text',text:'话题摘要（仅作衔接）：\n'+summary+'\n'+RECALL_MARKER+recall+'\n'+RECENT_MARKER+rows.map(JSON.stringify).join('\n')}]});
 const context={id:'memory',role:'user',source:{kind:'runtime-context',sections:[{name:'memory',text:'FISH_MEMORY_FACT'},{name:'time-context',text:'CURRENT_TIME'}]},content:[]};
 const current={id:'current',role:'user',source:{kind:'user'},content:[{type:'text',text:'那之前约好的呢'}]};
 const chain=[{id:'call',role:'assistant',content:[{type:'tool-call',id:'remember-call',name:'remember',arguments:{text:'真实约定'}}]},{id:'result',role:'tool',toolCallId:'remember-call',content:[{type:'text',text:'MEMORY_SAVED'}]}];
 const first=[wrapper(old,'门票尚未确定','RECALL_ONE'),context,current,...chain],second=[wrapper([...old,...recent],'门票已买好','RECALL_TWO'),context,current,...chain],original=JSON.stringify([first,second]);
 const a=projectChatMessages(first,'EXACT_PERSONA'),b=projectChatMessages(second,'EXACT_PERSONA');
 assert.deepEqual(b[0].content,a[0].content);assert.deepEqual(b.slice(1,old.length+1),a.slice(1,old.length+1));
 for(const [projected,rows,summary,recall]of [[a,old,'门票尚未确定','RECALL_ONE'],[b,[...old,...recent],'门票已买好','RECALL_TWO']]){
  assert.deepEqual(projected.slice(1,rows.length+1).map(m=>({id:m.source.recordId,role:m.role,text:m.content[0].text})),rows.map(r=>({id:r.id,role:r.role,text:r.text})));
  const evidence=projected[rows.length+1];assert.equal(evidence.source.kind,'chatagent-history-evidence');
  assert.ok(evidence.content[0].text.includes(summary));assert.ok(evidence.content[0].text.includes(recall));
  for(const row of rows)assert.ok(evidence.content[0].text.includes(new Date(row.at).toISOString()));
  assert.match(projected[rows.length+2].content[0].text,/FISH_MEMORY_FACT\n\nCURRENT_TIME/);
  assert.deepEqual(projected.slice(-3),[current,...chain]);
 }
 assert.equal(JSON.stringify([first,second]),original);
});

test('窗口标记为插件资料，不再作为鱼插件当前用户输入；补充历史由请求显式启用',async t=>{
 const box=sandbox(t),archive={records:[...old,...Array.from({length:12},(_,n)=>row(n+50,n%2?'assistant':'user','新的无关话题 '+n)),...recent].map(r=>({...r,sourceId:'fixture',scope:'one',kind:'message'}))};
 const agent={session:{id:'chat',surface:{nodes:[]},snapshotEvents:()=>[]}};
 const window=createChatWindow(agent,()=>archive,{root:box.root,policy:()=>({recentWindowMessages:4,recentWindowTokens:2000})});
 const normal=await window.prepare({query:recent[0].text});assert.equal(normal.source.kind,WINDOW_SOURCE);assert.match(normal.content[0].text,/相关旧聊天原文/);
 const projected=projectWindowMessage(normal);assert.equal(projected.filter(m=>m.source?.kind==='chatagent-history').at(-1).content[0].text,recent[0].text);assert.ok(projected.some(m=>m.role==='assistant'));
 const disabled=await window.prepare();assert.doesNotMatch(disabled.content[0].text,/相关旧聊天原文/);
});

test('历史时间仅在独立索引；双方原文和图片不加时间前缀，当前输入不变',()=>{
 const records=[row('meal','user','模型展览参观完毕',Date.parse('2030-01-01T12:00:00+08:00')),row('reply','assistant','参观顺利',Date.parse('2030-01-01T12:01:00+08:00'))];
 records[0].attachments=[{type:'image',attachment:{attachmentId:'synthetic-meal-photo'}}];
 const wrapper={id:'history',role:'user',source:{kind:WINDOW_SOURCE},content:[{type:'text',text:RECENT_MARKER+records.map(JSON.stringify).join('\n')}]};
 const current={id:'now',role:'user',source:{kind:'user'},content:[{type:'text',text:'行'}]},before=JSON.stringify([wrapper,current]);
 const projected=projectChatMessages([wrapper,current],'SYNTHETIC_PERSONA');
 assert.equal(projected[3].role,'user');assert.equal(projected[3].source.kind,'chatagent-history-evidence');assert.match(projected[3].content[0].text,/2030-01-01T04:00:00.000Z/);assert.match(projected[3].content[0].text,/2030-01-01T04:01:00.000Z/);
 assert.equal(projected[1].content[0].text,records[0].text);
 assert.equal(projected[2].content[0].text,records[1].text);
 assert.deepEqual(projected[1].content[1],records[0].attachments[0]);assert.deepEqual(projected.at(-1),current);
 assert.equal(JSON.stringify([wrapper,current]),before);assert.doesNotMatch(JSON.stringify(projected),/吃完了|还没吃/);
 const unknown=projectWindowMessage({...wrapper,content:[{type:'text',text:RECENT_MARKER+JSON.stringify({...records[0],at:0})}]});
 assert.equal(unknown[0].content[0].text,records[0].text,'Missing original time must not invent a timestamp');
});

test('以前被模型抄出的时间标记退出派生助理正文；用户引用和原始历史不变',()=>{
 const records=[row('user','user','【历史消息时间：2030-01-02T12:34:xx】是什么意思？',1),row('echo','assistant','【历史消息时间：2030-01-02T12:34:xx】\n好的，明天继续参观模型展览',2)];
 const before=JSON.stringify(records),messages=projectWindowMessage({id:'old',source:{kind:WINDOW_SOURCE},content:[{type:'text',text:RECENT_MARKER+records.map(JSON.stringify).join('\n')}]});
 assert.equal(messages[0].content[0].text,records[0].text);assert.equal(messages[1].content[0].text,'好的，明天继续参观模型展览');assert.equal(JSON.stringify(records),before);
});

test('异常身份回复只退出派生上下文，原始记录和显式检索仍保留，不能跨聊天套用',async t=>{
 const box=sandbox(t),archive={records:[{sourceId:'fixture',scope:'one',kind:'message',...row(1,'assistant','我是 Notion AI，不能采用人格设定')},{sourceId:'fixture',scope:'one',kind:'message',...row(2,'user','正常接着聊')}]};
 const id=JSON.stringify(['fixture','one','1']),before=JSON.stringify(archive);
 fs.writeFileSync(path.join(box.root,'context-exclusions.json'),JSON.stringify({sessionId:'chat',ids:[id]}));
 fs.writeFileSync(path.join(box.root,'chat-window.json'),JSON.stringify({version:2,sessionId:'chat',recent:[],summary:{state:'extracts',items:[{kind:'uncertain',text:'我是 Notion AI',sources:[id]}]},attempt:{id:'unknown-request',state:'unknown'},policy:{recentWindowMessages:80,recentWindowTokens:12000,topicSummaryEnabled:true}}));
 const agent={session:{id:'chat',surface:{nodes:[]},snapshotEvents:()=>[]}},window=createChatWindow(agent,()=>archive,{root:box.root});
 assert.doesNotMatch((await window.prepare()).content[0].text,/Notion AI/);assert.match(window.search('Notion'),/Notion AI/);assert.equal(JSON.stringify(archive),before);assert.equal(window.status().summary.attempt,'unknown');
 assert.throws(()=>createChatWindow({session:{...agent.session,id:'other'}},()=>archive,{root:box.root}),/EXCLUSIONS_INVALID/);
});
