// Adapter for an explicitly copied WeChatAgent plugin workspace. No WeChat transport.
import {createCourseTimetable} from './course-timetable.mjs';
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import {markPluginTool} from './tool-catalog.mjs';
export async function connectLocalUserPlugins({agent,root,publish,lookup,profile,now=Date.now}){
 if(!root)return {close:async()=>{}};
 const capsule=JSON.parse(fs.readFileSync(path.join(root,'chatagent-binding.json'),'utf8'));
 if(capsule.sessionId!==agent.session.id)throw Error('LOCAL_PLUGIN_SESSION_MISMATCH');
 const load=rel=>import(pathToFileURL(path.join(root,rel)).href);
 const {PluginRuntime}=await load('packages/plugin-api/index.mjs');
 const {ReminderStore}=await load('plugins/daily-reminders/lib/store.mjs'),{ReminderScheduler}=await load('plugins/daily-reminders/lib/scheduler.mjs');
 let closed=false,context='';
 const turn=()=>({conversationKey:capsule.key,conversationName:profile()?.name??'Chatagent',sessionId:agent.session.id,replies:[],toolCalls:0,modelCalls:0,networkOptOut:true});
 const runtime=new PluginRuntime({root,accountScope:capsule.account,now,isAllowed:()=>!closed,canSchedule:()=>false,personaFor:()=>({persona:profile()?.persona?.text??'',personaName:profile()?.persona?.name??'Chatagent'}),fetchText:async()=>{throw Error('LOCAL_PLUGIN_NETWORK_DISABLED');}});
 const timetable=createCourseTimetable({root,busy:()=>agent.status!=='idle',reload:async()=>{runtime.dirty=true;await runtime.sync();if(!runtime.isActive('course-query',capsule.key))throw Error('PLUGIN_TIMETABLE_RELOAD_FAILED');}});
 const active=runtime.active.bind(runtime);runtime.active=(record,key,permission)=>profile()?.capabilities?.find(p=>p.id===record.id)?.values.enabled!==false&&active(record,key,permission);
 await runtime.sync();const disposers=[];
 for(const tool of runtime.toolDefinitions(capsule.key)){
  if(!['course-query','daily-reminders'].includes(tool.pluginId))continue;
  disposers.push(agent.ctx.tools.register(markPluginTool({name:tool.name,description:tool.description,parameters:tool.parameters,output:{schema:{type:'object',properties:{text:{type:'string'}},required:['text']},render:(_,r)=>[{type:'text',text:r.text}]},async execute(args,execution){const result=await runtime.execute(tool.name,args,turn(),execution?.signal);if(result.isError)throw Error(result.content);return {text:result.content};}},{id:tool.pluginId,name:tool.pluginId==='course-query'?'课表查询':'事项提醒',description:tool.description})));
 }
 disposers.push(agent.ctx.on('agent/pre-step',async(_event,next)=>{const hooks=await runtime.hooks('before-context',{},turn());context=hooks.map(h=>h?.context??'').filter(Boolean).join('\n');return next();}));
 disposers.push(agent.ctx.systemPrompt.context({name:'chatagent:local-user-plugins',required:true,order:890,interpolate:false,text:()=>context}));
 const store=new ReminderStore(root,capsule.account),statusFile=path.join(root,'state/reminders/host-status.json');
 const heartbeat=()=>fs.writeFileSync(statusFile,JSON.stringify({online:!closed,account:capsule.account,at:now(),destination:'chatagent'}));
 const scheduler=new ReminderScheduler({store,now,allowed:key=>!closed&&capsule.remindersEnabled&&profile()?.capabilities?.find(p=>p.id==='daily-reminders')?.values.enabled!==false&&profile()?.toolGrants?.[agent.session.id]?.includes('daily-reminders__manage')&&key===capsule.key,ready:()=>!closed,send:async batch=>{const deliveryId='reminder-'+batch.id;publish({deliveryId,text:batch.text});if(!lookup(deliveryId))throw Error('LOCAL_DELIVERY_UNPROVEN');return {confirmed:true,delivered:'database-confirmed',deviceReceived:false};}});
 heartbeat();const timer=setInterval(()=>{heartbeat();void scheduler.tick();},5000);timer.unref?.();
 return {runtime,timetable,async close(){closed=true;clearInterval(timer);heartbeat();await scheduler.close();await runtime.dispose();for(const dispose of disposers)dispose();}};
}
