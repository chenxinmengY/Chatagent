// Real installed DSH loop + real copied plugin code, synthetic data and model.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createDshBridgeRuntime} from '../../packages/dsh-adapter/bridge-runtime.mjs';
import {ChatStore} from '../../packages/conversation/store.mjs';
import {Preferences} from '../../packages/conversation/preferences.mjs';
import {createProactiveScheduler} from '../../packages/conversation/proactive.mjs';
const sdk=path.resolve(process.argv[2]),root=path.resolve(process.argv[3]),project=path.resolve(import.meta.dirname,'../..');
const bridge=await import(pathToFileURL(path.resolve(process.env.CHATAGENT_COURSE_BRIDGE_ENTRY??path.join(project,'packages/dsh-bridge/index.mjs'))).href);
fs.mkdirSync(root,{recursive:true});
if(fs.readdirSync(root).length)throw Error('FIXTURE_ROOT_MUST_BE_EMPTY');
const load=name=>import(pathToFileURL(path.join(sdk,name,'lib/index.js')).href);
const [cordis,sessions,agents,llm,prompt,tools,projection,persistence,loop]=await Promise.all(['cordis','dsh-session','dsh-agent','dsh-llm','dsh-system-prompt','dsh-tools','dsh-session-projection','dsh-session-persistence-jsonl','dsh-agent-loop'].map(load));
const originalFetch=globalThis.fetch;let externalCalls=0;
globalThis.fetch=(input,init)=>{if(new URL(typeof input==='string'||input instanceof URL?input:input.url).hostname!=='127.0.0.1'){externalCalls++;throw Error('NETWORK_DISABLED');}return originalFetch(input,init);};
const pluginRoot=path.join(root,'local-plugins'),source=path.join(project,'packages/local-user-plugins');
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value,null,2));};
for(const rel of ['packages/plugin-api','packages/extension-runtime/catalog.mjs','packages/dsh-social-bridge-plugin/deadline.mjs','components/qq-bridge/src/safe-fetch.js','plugins/course-query/index.mjs','plugins/course-query/plugin.json','plugins/course-query/lib','plugins/daily-reminders']){
 fs.mkdirSync(path.dirname(path.join(pluginRoot,rel)),{recursive:true});fs.cpSync(path.join(source,rel),path.join(pluginRoot,rel),{recursive:true});
}
write(path.join(pluginRoot,'package.json'),{type:'module'});
const courseName='SYNTHETIC_COURSE_742',courseRoom='SYNTHETIC_ROOM_981',courseAnswer='SYNTHETIC_QUERY_ANSWER_782',queryText='查一下课表 SYNTHETIC_LOOKUP_REQUEST_524',syntheticDay=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(Date.now());
write(path.join(pluginRoot,'plugins/course-query/assets/timetable.json'),{schemaVersion:1,revision:'synthetic',timezone:'Asia/Shanghai',conflicts:[],bells:[{period:1,start:'08:15',end:'09:00'}],coveredDates:[syntheticDay],courses:[{id:'synthetic-course',date:syntheticDay,name:courseName,start:'08:15',end:'09:00',periods:[1],teacher:'SYNTHETIC_TEACHER_425',room:courseRoom}]});
write(path.join(pluginRoot,'config/plugins.json'),{version:1,plugins:Object.fromEntries(['course-query','daily-reminders'].map(id=>[id,{enabled:true,generation:'synthetic',permissions:['storage'],chats:['wechat:private:1'],settings:{}}]))});
write(path.join(pluginRoot,'config/wechatagent.json'),{wechat:{whitelist:{private:['1']}}});
const sessionId='chatagent-'+randomUUID(),account='a'.repeat(64),bridgeRoot=path.join(root,'bridge');
write(path.join(bridgeRoot,'identity.json'),{format:'chatagent-dsh-bridge-v1',sessionId});
write(path.join(pluginRoot,'chatagent-binding.json'),{sessionId,account,key:'wechat:private:1',remindersEnabled:false});
const token='synthetic-course-query-token'.repeat(3),tokenFile=path.join(root,'token');write(tokenFile,token);
const ctx=new cordis.Context(),captured=[],memories=[];let main,runtime,fiber,summaryCalls=0,at=Date.parse(syntheticDay+'T12:00:00+08:00');
const chatRoot=path.join(root,'chat');fs.mkdirSync(chatRoot);const store=new ChatStore(path.join(chatRoot,'chat.sqlite'),{now:()=>at});
const policy={allowedTools:['course-query__query','daily-reminders__manage','remember','synthetic_other'],recentWindowMessages:4,recentWindowTokens:2000,topicSummaryEnabled:true,maxMessages:2,minIntervalMs:0};
const emitText=function*(value){yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:value}};yield {type:'finish',reason:{kind:'stop'}};};
const call=(name,args,id)=>({type:'tool-call',id,name,arguments:JSON.stringify(args)});
const emitCalls=function*(blocks){for(let i=0;i<blocks.length;i++){yield {type:'block-start',index:i,blockType:'tool-call'};yield {type:'block-end',index:i,block:blocks[i]};}yield {type:'finish',reason:{kind:'tool-calls'}};};
ctx.on('agent/error',e=>console.error('Synthetic agent error:',e.error));
try{
 for(const [plugin,config] of [[sessions.default,{}],[agents.default,{}],[llm.default,{}],[prompt.default,{includeRuntimeContext:false}],[tools.default,{mode:'native'}],[projection.default,{}],[persistence,{root:path.join(root,'sessions'),compression:'none',listConcurrency:1}]])await ctx.plugin(plugin,config);
 ctx.llm.registerAdapter(['synthetic'],new class extends llm.LlmAdapter{async *stream(options){
  const copy=JSON.parse(JSON.stringify(options));captured.push(copy);
  if(options.sessionId.startsWith('chatagent-summary-')){summaryCalls++;assert.doesNotMatch(JSON.stringify(copy.messages),/SYNTHETIC_(?:COURSE|ROOM|QUERY_ANSWER|TEACHER)_/);const raw=options.messages[0].content[0].text,input=JSON.parse(raw.slice(raw.indexOf('\n')+1));yield* emitText(JSON.stringify({items:[{kind:'fact',text:'普通聊天可以衔接',sources:[input.records[0].id]}]}));return;}
  if(options.sessionId.startsWith('chatagent-plugin-')){assert.doesNotMatch(JSON.stringify(copy.messages),/SYNTHETIC_(?:COURSE|ROOM|QUERY_ANSWER|TEACHER)_/);yield* emitText('今天是平静的一天，实验做完了。');return;}
  if(options.sessionId==='synthetic-compaction'){assert.doesNotMatch(JSON.stringify(copy.messages),/SYNTHETIC_(?:COURSE|ROOM|QUERY_ANSWER|TEACHER)_/);yield* emitText('合成压缩摘要');return;}
  if(options.sessionId!==sessionId){yield* emitText('OTHER_SESSION_UNCHANGED');return;}
  const current=options.messages.findLast(m=>['user','chatagent-proactive'].includes(m.source?.kind)),input=current.content.map(b=>b.text??'').join(''),result=options.messages.filter(m=>m.role==='tool');
  // Only results after this turn's current user message count as live results.
  const since=options.messages.slice(options.messages.indexOf(current)+1).filter(m=>m.role==='tool');
  const lookup=[queryText,'再查一次课表','今天呢'].includes(input);
  assert.equal(options.tools.some(t=>t.name==='course-query__query'),lookup,'Course tool is only presented for a current lookup request');
  if(lookup){
   assert.doesNotMatch(JSON.stringify(options.messages),/我已经上课了|事项提醒必须调用|普通聊天回复|SYNTHETIC_PERSONAL_MEMORY/,'Lookup parser has no personal chat, reminder context or long-term memory');
   assert.deepEqual(options.tools.map(t=>t.name),['course-query__query']);
   assert.equal(since.length,0,'Course results are rendered without asking the model to write a reply');
   yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text:'这会儿都过十二点半了，主人快去睡觉。'}};
   yield* emitCalls([call('course-query__query',{action:'day',date:syntheticDay},'course-'+randomUUID()),call('remember',{text:'same-batch query memory'},'parallel-memory-'+randomUUID())]);return;
  }
  assert.match(JSON.stringify(options.messages),/事项提醒必须调用/,'Independent reminder context remains mounted');
  assert.doesNotMatch(JSON.stringify(options.messages),/SYNTHETIC_(?:COURSE|ROOM|QUERY_ANSWER|TEACHER|LOOKUP_REQUEST)_/,'Final native adapter input cannot contain an earlier lookup question, timetable data or answer');
  if(input==='早'&&!since.length){yield* emitCalls([call('course-query__query',{action:'day',date:syntheticDay},'unrequested-'+randomUUID())]);return;}
  if(input==='早'&&since.length){assert.ok(since.every(m=>m.isError));assert.doesNotMatch(JSON.stringify(since),new RegExp(courseRoom));}
  if(input==='还记得刚才说的具体内容吗'&&!since.length){yield* emitCalls([call('chatagent_history_search',{query:'刚才的课表答复'},'history-'+randomUUID())]);return;}
  if(input==='记下我的个人状态'&&!since.length){assert.ok(options.tools.some(t=>t.name==='remember'));yield* emitCalls([call('remember',{text:'用户已经上课了，学校实验做完了'},'normal-memory-'+randomUUID())]);return;}
  if(input==='用一下其他工具'&&!since.length){yield* emitCalls([call('synthetic_other',{},'other-'+randomUUID())]);return;}
  if(input==='查看独立提醒'&&!since.length){yield* emitCalls([call('daily-reminders__manage',{action:'list'},'reminders-'+randomUUID())]);return;}
  if(input==='用一下其他工具'&&since.length)assert.match(JSON.stringify(since),/OTHER_TOOL_RESULT/);
  if(input==='查看独立提醒'&&since.length){assert.ok(since.every(m=>!m.isError));assert.match(JSON.stringify(since),/plans/);}
  if(input.startsWith('系统安排')){yield* emitText('SILENT');return;}
  yield* emitText('普通聊天回复：'+input);
 }}());
 const tool=(name,execute)=>({name,description:'Synthetic isolated tool',parameters:{type:'object',properties:{text:{type:'string'}}},output:{schema:{type:'object',properties:{text:{type:'string'}},required:['text']},render:(_,r)=>[{type:'text',text:r.text}]},execute});
 ctx.tools.register(tool('remember',args=>{memories.push(args.text);return {text:'saved ordinary memory'};}));
 ctx.tools.register(tool('synthetic_other',()=>({text:'OTHER_TOOL_RESULT'})));
 await ctx.plugin(loop.default,{agents:[]});
 let workspace;ctx.provide('workspaceRegistry',{async resolveByPath(){return workspace;},async create(cwd,title){return workspace={id:'synthetic-workspace',path:cwd,title,sessionIds:[],async attachSession(id){this.sessionIds.push(id);}};}});
 ctx.provide('sessionController',{agents:{resolveAgent:async id=>({agent:ctx.agents.get(id)})},async create({sessionId}){main=(await ctx.agents.create({sessionId,meta:{cwd:workspace.path},agentOptions:{provider:'synthetic',model:'fixture'}})).agent;main.ctx.systemPrompt.context({name:'memory',order:900,required:true,text:()=>memories.join('\n')});},async rename(){},async prompt({sessionId,requestId,content}){ctx.agents.get(sessionId).followup(llm.createUserMessage({source:{kind:'user',rpcId:requestId},content}));}});
 const port=Number(process.env.CHATAGENT_COURSE_TEST_PORT??37912);
 const config={root:bridgeRoot,cwd:path.join(root,'workspace'),tokenFile,port,llmModule:pathToFileURL(path.join(sdk,'dsh-llm/lib/index.js')).href,localPluginsRoot:pluginRoot,mediaOptions:{attachmentsRoot:path.join(chatRoot,'attachments')}};
 fiber=ctx.plugin(bridge,config);await fiber;
 runtime=await createDshBridgeRuntime({url:'http://127.0.0.1:'+port,token});
 async function send(text){
  const row=store.submit({deviceId:'fixture',clientMessageId:randomUUID(),text,queuedAt:at});assert.ok(store.claim({policy}));
  const value=await runtime.reply({id:row.id,text,mode:'social',policy});store.complete(row.id,value);at+=2000;store.flushReplyParts();at+=2000;
  for(let n=0;(await runtime.bridgeStatus()).busy;n++){assert.ok(n<200);await new Promise(resolve=>setTimeout(resolve,5));}
  return {id:row.id,text:value};
 }
 await send('我已经上课了，学校实验做完了');
 const first=await send(queryText);assert.match(first.text,new RegExp(courseRoom));assert.deepEqual(memories,[]);assert.doesNotMatch(first.text,/主人|睡觉|第二段|SYNTHETIC_QUERY_ANSWER/);assert.equal(captured.filter(c=>c.sessionId===sessionId&&c.messages.some(m=>m.source?.kind==='user'&&m.content.some(b=>b.text===queryText))).length,1,'Result is rendered without a second model call');
 await send('今天呢');
 main.ctx.provide('compaction',{async compactNow(agent,signal){try{const events=agent.session.snapshotEvents(),nodes=new Set(agent.session.surface.nodes),messages=events.filter(e=>nodes.has(e.seq)).map(e=>sessions.deriveEventMessage(e)).filter(Boolean);for await(const _ of ctx.llm.stream({provider:'synthetic',model:'fixture',sessionId:'synthetic-compaction',messages,tools:[],signal})){};}catch(e){console.error('Synthetic compaction error:',e);throw e;}}});
 const compacted=await originalFetch('http://127.0.0.1:'+port+'/v1/context/compact',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'});const compactResult=await compacted.json();assert.equal(compacted.status,200,JSON.stringify(compactResult));assert.ok(captured.some(c=>c.sessionId==='synthetic-compaction'));
 const rawBefore=main.session.snapshotEvents().filter(e=>e.type==='assistant/message').map(e=>e.data.message);
 await send('你好，聊点别的吧');assert.ok(main.session.snapshotEvents().some(e=>e.type==='assistant/message'&&e.data.message.content.some(b=>b.type==='text'&&b.text.includes(courseName))));
 await send('早');await send('课间呢');
 await send('还记得刚才说的具体内容吗');await send('记下我的个人状态');await send('用一下其他工具');await send('查看独立提醒');
 assert.deepEqual(memories,['用户已经上课了，学校实验做完了']);
 for(let n=0;n<6;n++)await send('普通闲聊 '+n);
 await new Promise(resolve=>setTimeout(resolve,1200));assert.ok(summaryCalls>0,'Idle summary reached the actual native model boundary');
 const view=await runtime.filterContextHistory(store.db.prepare('SELECT m.id,m.role,m.text,m.created_at,COALESCE(m.parent,p.parent) contextParent FROM messages m LEFT JOIN reply_parts p ON p.id=m.id ORDER BY m.seq').all());
 assert.doesNotMatch(JSON.stringify(view),new RegExp(courseAnswer+'|第二段查询答复|SYNTHETIC_LOOKUP_REQUEST_524'));assert.match(JSON.stringify(view),/我已经上课了/);
 // Seed the actual proactive builder with the query's first and split replies.
 const preferences=new Preferences(store),p=preferences.read();Object.assign(p.policy,{proactiveEnabled:true,proactiveSchedule:'periodic',proactiveMinIntervalMinutes:1,proactiveJitterMinutes:0,proactiveIdleMinutes:1,proactiveMaxPerDay:0});preferences.save(p);
 const second=await send('再查一次课表');
 const schedule=createProactiveScheduler({store,backend:runtime,preferences,now:()=>at,random:()=>0});await schedule.tick();at+=120000;await schedule.tick();
 const proactive=captured.findLast(c=>c.messages.some(m=>m.source?.kind==='chatagent-proactive'));assert.ok(proactive);assert.doesNotMatch(JSON.stringify(proactive.messages),new RegExp(courseAnswer+'|第二段查询答复|SYNTHETIC_LOOKUP_REQUEST_524|再查一次课表'));
 const notebook=(await runtime.pluginStatus()).find(p=>p.id==='fish-notebook');
 await runtime.pluginAction('fish-notebook','settings',{...notebook.settings,enabled:true});
 await runtime.pluginAction('fish-notebook','run',{requestId:'synthetic-notebook',action:'run'});
 for(let n=0;(await runtime.pluginStatus()).find(p=>p.id==='fish-notebook').running;n++){assert.ok(n<200);await new Promise(resolve=>setTimeout(resolve,10));}
 const diary=captured.find(c=>c.sessionId.startsWith('chatagent-plugin-'));assert.ok(diary,'Notebook generation reached the native model boundary');assert.match(JSON.stringify(diary.messages),/我已经上课了/);assert.doesNotMatch(JSON.stringify(diary.messages),new RegExp(courseAnswer+'|第二段查询答复'));
 const beforeReload=captured.length;await runtime.close();await fiber.dispose();fiber=ctx.plugin(bridge,config);await fiber;runtime=await createDshBridgeRuntime({url:'http://127.0.0.1:'+port,token});assert.equal(captured.length,beforeReload);
 await send('重载后普通聊天');assert.deepEqual(memories,['用户已经上课了，学校实验做完了']);
 const status=await runtime.bridgeStatus();assert.ok(status.context.toolOnlyRequestIds.includes(first.id)&&status.context.toolOnlyRequestIds.includes(second.id));
 assert.ok(rawBefore.every(m=>main.session.snapshotEvents().some(e=>e.type==='assistant/message'&&e.data.message.id===m.id)));
 const report={passed:true,installedDshSdk:true,realLocalPluginCode:true,syntheticTimetable:true,queryAnswered:true,resultRenderedWithoutModel:true,queryInputHasNoPersonalContext:true,modelPreambleDiscarded:true,queryRepeatedOnDemand:true,queryFollowupWorks:true,queryQuestionExcluded:true,unrequestedQueryBlocked:true,nextTurnAdapterInputClean:true,summaryAdapterInputClean:true,compactionInputClean:true,archiveSearchClean:true,proactiveAdapterInputClean:true,notebookAdapterInputClean:true,splitQueryRepliesExcluded:true,memoryWritesBlockedInQueryTurn:true,ordinaryPersonalMemoryPreserved:true,independentReminderToolPreserved:true,otherToolPreserved:true,rawHistoryPreserved:true,reloadDoesNotReplay:true,externalModelCalls:externalCalls,syntheticModelCalls:captured.length,summaryCalls,productionDataWritten:false,liveBridgeReloaded:false};
 write(path.join(root,'adapter-inputs.synthetic.json'),captured);write(path.join(root,'report.json'),report);console.log(JSON.stringify(report,null,2));
}finally{write(path.join(root,'adapter-inputs.synthetic.json'),captured);await runtime?.close();await ctx.fiber.dispose();store.close();globalThis.fetch=originalFetch;}
