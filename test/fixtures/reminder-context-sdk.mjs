// Actual installed DSH agent, copied reminder plugin, synthetic model and data.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';import {pathToFileURL} from 'node:url';import {DatabaseSync} from 'node:sqlite';
import * as bridge from '../../packages/dsh-bridge/index.mjs';
import {createDshBridgeRuntime} from '../../packages/dsh-adapter/bridge-runtime.mjs';
import {ChatStore} from '../../packages/conversation/store.mjs';
import {Preferences} from '../../packages/conversation/preferences.mjs';
import {createProactiveScheduler} from '../../packages/conversation/proactive.mjs';
import {ReminderStore} from '../../packages/local-user-plugins/plugins/daily-reminders/lib/store.mjs';
import {ReminderScheduler} from '../../packages/local-user-plugins/plugins/daily-reminders/lib/scheduler.mjs';
const sdk=path.resolve(process.argv[2]),root=path.resolve(process.argv[3]),project=path.resolve(import.meta.dirname,'../..');
fs.mkdirSync(root,{recursive:true});assert.equal(fs.readdirSync(root).length,0);
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value,null,2));};
const load=name=>import(pathToFileURL(path.join(sdk,name,'lib/index.js')).href);
const [cordis,sessions,agents,llm,prompt,tools,projection,persistence,loop]=await Promise.all(['cordis','dsh-session','dsh-agent','dsh-llm','dsh-system-prompt','dsh-tools','dsh-session-projection','dsh-session-persistence-jsonl','dsh-agent-loop'].map(load));
const originalFetch=globalThis.fetch;let externalCalls=0;
globalThis.fetch=(input,init)=>{if(new URL(typeof input==='string'||input instanceof URL?input:input.url).hostname!=='127.0.0.1'){externalCalls++;throw Error('NETWORK_DISABLED');}return originalFetch(input,init);};
const pluginRoot=path.join(root,'local-plugins'),source=path.join(project,'packages/local-user-plugins');
for(const rel of ['packages/plugin-api','packages/extension-runtime/catalog.mjs','packages/dsh-social-bridge-plugin/deadline.mjs','components/qq-bridge/src/safe-fetch.js','plugins/course-query','plugins/daily-reminders']){
 fs.mkdirSync(path.dirname(path.join(pluginRoot,rel)),{recursive:true});fs.cpSync(path.join(source,rel),path.join(pluginRoot,rel),{recursive:true});
}
write(path.join(pluginRoot,'package.json'),{type:'module'});
write(path.join(pluginRoot,'plugins/course-query/assets/timetable.json'),{schemaVersion:1,revision:'synthetic',timezone:'Asia/Shanghai',conflicts:[],bells:[],coveredDates:['2030-01-01'],courses:[{id:'synthetic-course',date:'2030-01-01',name:'合成课程',start:'08:00',end:'08:45',periods:[1],teacher:'SYNTHETIC_TEACHER',room:'SYNTHETIC_ROOM'}]});
write(path.join(pluginRoot,'config/plugins.json'),{version:1,plugins:Object.fromEntries(['course-query','daily-reminders'].map(id=>[id,{enabled:true,generation:'synthetic',permissions:['storage'],chats:['wechat:private:1'],settings:{}}]))});
write(path.join(pluginRoot,'config/wechatagent.json'),{wechat:{whitelist:{private:['1']}}});
const sessionId='chatagent-'+randomUUID(),account='a'.repeat(64),key='wechat:private:1',bridgeRoot=path.join(root,'bridge');
write(path.join(bridgeRoot,'identity.json'),{format:'chatagent-dsh-bridge-v1',sessionId});
write(path.join(pluginRoot,'chatagent-binding.json'),{sessionId,account,key,remindersEnabled:false});
const token='synthetic-reminder-token'.repeat(3),tokenFile=path.join(root,'token');write(tokenFile,token);
const ctx=new cordis.Context(),captured=[],memories=[];let main,runtime,fiber,scheduler,summaryCalls=0,at=Date.now();
const recurring='RECURRING_CANARY_479',once='ONCE_CANARY_671',personal='PERSONAL_CAMPUS_RUN_932',diaryOld='LEGACY_DIARY_RECURRING_382';
const chatRoot=path.join(root,'chat');fs.mkdirSync(chatRoot);const store=new ChatStore(path.join(chatRoot,'chat.sqlite'),{now:()=>at});
store.db.exec('CREATE TABLE portable_records(key TEXT PRIMARY KEY,body TEXT NOT NULL)');
const policy={allowedTools:['daily-reminders__manage','remember','chatagent_history_search','chatagent_notebook__ask'],recentWindowMessages:8,recentWindowTokens:3000,topicSummaryEnabled:true,maxMessages:2,minIntervalMs:0};
const emitText=function*(text){yield {type:'block-start',index:0,blockType:'text'};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};};
const call=(name,args)=>({type:'tool-call',id:randomUUID(),name,arguments:JSON.stringify(args)});
const emitCalls=function*(blocks){for(let i=0;i<blocks.length;i++){yield {type:'block-start',index:i,blockType:'tool-call'};yield {type:'block-end',index:i,block:blocks[i]};}yield {type:'finish',reason:{kind:'tool-calls'}};};
ctx.on('agent/error',e=>console.error('Synthetic agent error:',e.error));
try{
 for(const [plugin,config]of [[sessions.default,{}],[agents.default,{}],[llm.default,{}],[prompt.default,{includeRuntimeContext:false}],[tools.default,{mode:'native'}],[projection.default,{}],[persistence,{root:path.join(root,'sessions'),compression:'none',listConcurrency:1}]])await ctx.plugin(plugin,config);
 ctx.llm.registerAdapter(['synthetic'],new class extends llm.LlmAdapter{async *stream(options){
  const copy=JSON.parse(JSON.stringify(options));captured.push(copy);
  if(options.sessionId.startsWith('chatagent-summary-')){summaryCalls++;assert.doesNotMatch(JSON.stringify(copy.messages),new RegExp(recurring+'|'+diaryOld));const raw=options.messages[0].content[0].text,input=JSON.parse(raw.slice(raw.indexOf('\n')+1));yield* emitText(JSON.stringify({items:[{kind:'fact',text:'个人近况和一次性安排可以衔接',sources:[input.records[0].id]}]}));return;}
  if(options.sessionId.startsWith('chatagent-plugin-')){assert.doesNotMatch(JSON.stringify(copy.messages),new RegExp(recurring+'|'+diaryOld));yield* emitText('今天聊了真实近况和明天的一次性安排。');return;}
  if(options.sessionId==='synthetic-compaction'){assert.doesNotMatch(JSON.stringify(copy.messages),new RegExp(recurring+'|'+diaryOld));yield* emitText('压缩后保留真实近况');return;}
  if(options.sessionId!==sessionId){yield* emitText('OTHER_SESSION');return;}
  const current=options.messages.findLast(m=>['user','chatagent-proactive'].includes(m.source?.kind)),input=current.content.map(b=>b.text??'').join(''),since=options.messages.slice(options.messages.indexOf(current)+1).filter(m=>m.role==='tool');
  const managing=input==='每天提醒我 '+recurring||input==='查看长期提醒';
  if(!managing)assert.doesNotMatch(JSON.stringify(options.messages),new RegExp(recurring+'|'+diaryOld),'Final adapter input must not restore recurring reminder facts');
  if(input==='每天提醒我 '+recurring){
   if(!since.length){assert.equal(options.tools.some(t=>t.name==='remember'),false);yield* emitCalls([call('daily-reminders__manage',{action:'create',repeat:'daily',time:'23:58',text:recurring,phrase:recurring}),call('remember',{text:'SHOULD_NOT_BE_SAVED'})]);return;}
   assert.match(JSON.stringify(since),/created/);assert.ok(since.some(m=>m.isError),'Parallel memory write rejected');yield* emitText(recurring+' 已保存在提醒计划');return;
  }
  if(input==='提醒我明天下午 '+once&&!since.length){yield* emitCalls([call('daily-reminders__manage',{action:'create',repeat:'once',delayMinutes:30,text:once,phrase:once})]);return;}
  if(input==='查看长期提醒'&&!since.length){yield* emitCalls([call('daily-reminders__manage',{action:'list',kind:'repeating'})]);return;}
  if(input==='查看长期提醒'&&since.length){assert.match(JSON.stringify(since),new RegExp(recurring));yield* emitText(recurring+' 独立计划仍有效');return;}
  if(input==='保存我的真实近况'&&!since.length){assert.ok(options.tools.some(t=>t.name==='remember'));yield* emitCalls([call('remember',{text:personal})]);return;}
  if(input==='查重复提醒的旧聊天'&&!since.length){yield* emitCalls([call('chatagent_history_search',{query:'每天提醒我'})]);return;}
  if(input==='看今天的日记'&&!since.length){yield* emitCalls([call('chatagent_notebook__ask',{})]);return;}
  if(input.startsWith('系统安排')){yield* emitText('SILENT');return;}
  yield* emitText(input.includes(once)?once+' 安排已保存':'好的，普通聊天继续。');
 }}());
 ctx.tools.register({name:'remember',description:'Synthetic memory',parameters:{type:'object',properties:{text:{type:'string'}}},output:{schema:{type:'object',properties:{text:{type:'string'}}},render:(_,r)=>[{type:'text',text:r.text}]},execute:args=>{memories.push(args.text);return {text:'saved'};}});
 await ctx.plugin(loop.default,{agents:[]});
 let workspace;ctx.provide('workspaceRegistry',{async resolveByPath(){return workspace;},async create(cwd,title){return workspace={id:'synthetic-workspace',path:cwd,title,sessionIds:[],async attachSession(id){this.sessionIds.push(id);}};}});
 ctx.provide('sessionController',{agents:{resolveAgent:async id=>({agent:ctx.agents.get(id)})},async create({sessionId}){main=(await ctx.agents.create({sessionId,meta:{cwd:workspace.path},agentOptions:{provider:'synthetic',model:'fixture'}})).agent;main.ctx.systemPrompt.context({name:'memory',order:900,required:true,text:()=>memories.join('\n')});},async rename(){},async prompt({sessionId,requestId,content}){ctx.agents.get(sessionId).followup(llm.createUserMessage({source:{kind:'user',rpcId:requestId},content}));}});
 const port=37915,config={root:bridgeRoot,cwd:path.join(root,'workspace'),tokenFile,port,llmModule:pathToFileURL(path.join(sdk,'dsh-llm/lib/index.js')).href,localPluginsRoot:pluginRoot,mediaOptions:{attachmentsRoot:path.join(chatRoot,'attachments')}};
 fiber=ctx.plugin(bridge,config);await fiber;runtime=await createDshBridgeRuntime({url:'http://127.0.0.1:'+port,token});runtime.attachDelivery({store,attachments:{verify(){throw Error('NO_ATTACHMENTS_IN_FIXTURE');}}});
 async function send(text){const row=store.submit({deviceId:'fixture',clientMessageId:randomUUID(),text,queuedAt:at});assert.ok(store.claim({policy}));const reply=await runtime.reply({id:row.id,text,mode:'social',policy});store.complete(row.id,reply);at+=2000;store.flushReplyParts();at+=2000;for(let n=0;(await runtime.bridgeStatus()).busy;n++){assert.ok(n<200);await new Promise(r=>setTimeout(r,5));}return {id:row.id,text:reply};}
 await send('今天校园跑已经完成了 '+personal);
 const repeating=await send('每天提醒我 '+recurring);assert.match(repeating.text,new RegExp(recurring));assert.deepEqual(memories,[]);
 const oneoff=await send('提醒我明天下午 '+once);assert.match(oneoff.text,new RegExp(once));
 await send('你好');await send('查看长期提醒');await send('接着聊');await send('保存我的真实近况');assert.deepEqual(memories,[personal]);await send('查重复提醒的旧聊天');
 main.ctx.provide('compaction',{async compactNow(agent,signal){const events=agent.session.snapshotEvents(),nodes=new Set(agent.session.surface.nodes),messages=events.filter(e=>nodes.has(e.seq)).map(e=>sessions.deriveEventMessage(e)).filter(Boolean);for await(const _ of ctx.llm.stream({provider:'synthetic',model:'fixture',sessionId:'synthetic-compaction',messages,tools:[],signal})){};}});
 const compact=await originalFetch('http://127.0.0.1:'+port+'/v1/context/compact',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'});assert.equal(compact.status,200);
 // Real isolated scheduler merges recurring + once in one batch and sends to an isolated ChatStore only.
 const reminderStore=new ReminderStore(pluginRoot,account);let due=Date.now();
 const daily=reminderStore.manage(key,{action:'create',repeat:'daily',time:'12:01',text:recurring+'_DELIVERY',phrase:recurring+'_DELIVERY'},due);
 const single=reminderStore.manage(key,{action:'create',repeat:'once',delayMinutes:1,text:once+'_DELIVERY',phrase:once+'_DELIVERY'},due);
 reminderStore.run('UPDATE plans SET next_due=? WHERE id IN (?,?)',due+60000,Number(daily.plan.id.slice(1)),Number(single.plan.id.slice(1)));
 scheduler=new ReminderScheduler({store:reminderStore,now:()=>due,allowed:()=>true,ready:()=>true,send:batch=>{store.publish({deliveryId:'reminder-'+batch.id,text:batch.text});return {confirmed:true,delivered:'database-confirmed'};}});
 due+=60000;await scheduler.tick();
 const rows=store.db.prepare('SELECT m.id,m.role,m.text,m.created_at,COALESCE(m.parent,p.parent) contextParent FROM messages m LEFT JOIN reply_parts p ON p.id=m.id ORDER BY m.seq').all(),view=await runtime.filterContextHistory(rows);
 assert.doesNotMatch(JSON.stringify(view),new RegExp(recurring));assert.match(JSON.stringify(view),new RegExp(once));assert.match(JSON.stringify(view),new RegExp(personal));assert.match(JSON.stringify(rows),new RegExp(recurring+'_DELIVERY'),'Visible original notification remains');
 // Ensure the final proactive and notebook adapters see the projected receipt, not a prompt-only instruction.
 const preferences=new Preferences(store),p=preferences.read();Object.assign(p.policy,{proactiveEnabled:true,proactiveSchedule:'periodic',proactiveMinIntervalMinutes:1,proactiveJitterMinutes:0,proactiveIdleMinutes:1,proactiveMaxPerDay:0,quietStart:0,quietEnd:0});preferences.save(p);
 const schedule=createProactiveScheduler({store,backend:runtime,preferences,now:()=>at,random:()=>0});await schedule.tick();at+=120000;await schedule.tick();
 const proactive=captured.findLast(c=>c.messages.some(m=>m.source?.kind==='chatagent-proactive'));assert.ok(proactive);assert.doesNotMatch(JSON.stringify(proactive.messages),new RegExp(recurring));assert.match(JSON.stringify(proactive.messages),new RegExp(once+'_DELIVERY'));
 let notebook=(await runtime.pluginStatus()).find(p=>p.id==='fish-notebook');await runtime.pluginAction('fish-notebook','settings',{...notebook.settings,enabled:true});
 await runtime.pluginAction('fish-notebook','run',{requestId:'synthetic-notebook',action:'run'});for(let n=0;(await runtime.pluginStatus()).find(p=>p.id==='fish-notebook').running;n++){assert.ok(n<200);await new Promise(r=>setTimeout(r,10));}
 const diary=captured.find(c=>c.sessionId.startsWith('chatagent-plugin-'));assert.ok(diary);assert.doesNotMatch(JSON.stringify(diary.messages),new RegExp(recurring));assert.match(JSON.stringify(diary.messages),new RegExp(once));assert.match(JSON.stringify(diary.messages),new RegExp(personal));
 // A previously saved diary is sanitized at tool/share boundaries without rewriting the original document.
 notebook=(await runtime.pluginStatus()).find(p=>p.id==='fish-notebook');const record=notebook.records[0],database=path.join(bridgeRoot,'plugins/plugins.sqlite'),db=new DatabaseSync(database);const stored={...record,text:'普通经历。'+diaryOld+'。明天的一次性安排。'};db.prepare('UPDATE documents SET body=? WHERE id=?').run(JSON.stringify(stored),record.id);db.close();
 write(path.join(bridgeRoot,'context-exclusions.json'),{sessionId,ids:[],reminderRedactions:[{id:'diary:'+record.id,remove:[diaryOld+'。']}]});
 const rawBefore=main.session.snapshotEvents();await runtime.close();await fiber.dispose();fiber=ctx.plugin(bridge,config);await fiber;runtime=await createDshBridgeRuntime({url:'http://127.0.0.1:'+port,token});runtime.attachDelivery({store,attachments:{verify(){throw Error('NO_ATTACHMENTS_IN_FIXTURE');}}});
 notebook=(await runtime.pluginStatus()).find(p=>p.id==='fish-notebook');await runtime.pluginAction('fish-notebook','settings',{...notebook.settings,share:true});
 for(let n=0;n<3;n++)await send('看今天的日记');await runtime.flushDeliveries();
 const shared=store.db.prepare("SELECT text FROM messages WHERE device='plugin-delivery' AND client_id LIKE 'plugin-%' ORDER BY seq DESC LIMIT 1").get();assert.ok(shared);assert.doesNotMatch(shared.text,new RegExp(diaryOld));assert.match(shared.text,/普通经历。明天的一次性安排。/);
 assert.match(JSON.stringify((await runtime.pluginStatus()).find(p=>p.id==='fish-notebook').records),new RegExp(diaryOld),'Stored original diary remains intact');
 for(let n=0;n<8;n++)await send('普通闲聊 '+n);await new Promise(r=>setTimeout(r,1200));assert.ok(summaryCalls>0);
 assert.ok(rawBefore.every(e=>main.session.snapshotEvents().some(next=>next.seq===e.seq)));
 const status=await runtime.bridgeStatus();assert.ok(status.context.reminders.excludedRequestIds.includes(repeating.id));assert.ok(!status.context.reminders.excludedRequestIds.includes(oneoff.id));
 const report={passed:true,installedDshSdk:true,realReminderPlugin:true,liveReminderManagementWorks:true,oneoffChatContextPreserved:true,personalStatePreserved:true,mixedReceiptProjected:true,visibleReceiptPreserved:true,nextTurnAdapterInputClean:true,summaryAdapterInputClean:true,compactionAdapterInputClean:true,archiveSearchClean:true,proactiveAdapterInputClean:true,notebookAdapterInputClean:true,legacyDiaryToolAndShareClean:true,originalDiaryPreserved:true,parallelRecurringMemoryBlocked:true,ordinaryMemoryPreserved:true,reloadSafe:true,externalModelCalls:externalCalls,syntheticModelCalls:captured.length,summaryCalls,productionDataWritten:false};
 write(path.join(root,'report.json'),report);console.log(JSON.stringify(report,null,2));
}finally{write(path.join(root,'adapter-inputs.synthetic.json'),captured);await scheduler?.close();await runtime?.close();await ctx.fiber.dispose();store.close();globalThis.fetch=originalFetch;}
