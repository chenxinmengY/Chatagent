import {randomUUID} from 'node:crypto';
import {projectWindowMessage} from './chat-continuity.mjs';
import {projectCourseQuery,courseTextStream,courseCallStream} from './course-query-reply.mjs';

const adapters=new WeakMap();
const chatContext=name=>name==='memory'||name==='time-context'||name.startsWith('chatagent:');

// Deployment plugins can add instructions after the normal prompt waterfall.
// Project the private chat's own prompt at the final adapter boundary; do not
// change canonical history, provider selection, or other sessions. Apply the
// current chat's tool policy here too: DSH 0.2.2 owns tools outside the prompt waterfall.
export function projectChatMessages(messages,prompt){
 let found=false;
 const projected=messages.flatMap(message=>{
  if(message.role==='system'&&message.source?.kind==='system-prompt'){
   if(found)return [];
   found=true;return [{...message,content:[{type:'text',text:prompt}]}];
  }
  if(message.source?.kind==='runtime-context'&&Array.isArray(message.source.sections)){
   const sections=message.source.sections.filter(section=>chatContext(section.name));
   if(!sections.length)return [];
   return [{...message,source:{...message.source,sections},content:[{type:'text',text:sections.map(section=>section.text).join('\n\n')}]}];
  }
  return projectWindowMessage(message);
 });
 if(!found)projected.unshift({id:randomUUID(),role:'system',source:{kind:'system-prompt'},content:[{type:'text',text:prompt}]});
 return projected;
}

export function installChatDispatch(ctx,sessionId,prompt,toolPolicy=()=>null,projectMessages=messages=>messages,courseQuery=()=>null){
 const service=ctx.get('llm'),raw=service?.[Symbol.for('cordis.original')]??service,attached=new Set();
 const attach=()=>{
  for(const {adapter} of raw.adapters.values()){
   if(attached.has(adapter))continue;
   let entry=adapters.get(adapter);
   if(!entry){
    entry={original:adapter.stream,originalPrepareCall:adapter.prepareCall,sessions:new Map()};
    const project=options=>{
     const own=entry.sessions.get(options.sessionId);if(!own)return options;
     const permits=own.toolPolicy();
     return {...options,messages:own.courseQuery()?projectCourseQuery(options.messages):projectChatMessages(own.projectMessages(options.messages),own.prompt()),...permits&&Array.isArray(options.tools)?{tools:options.tools.filter(tool=>permits(tool.name))}:{}};
    };
    const stream=(options,run)=>{
     const query=entry.sessions.get(options.sessionId)?.courseQuery();
     if(!query)return run(project(options));
     const reply=query.reply();
     return reply===undefined?courseCallStream(run(project(options))):courseTextStream(reply);
    };
    entry.stream=function(options){
     return stream(options,projected=>entry.original.call(this,projected));
    };
    if(typeof entry.originalPrepareCall==='function'){
     entry.prepareCall=async function(...args){const call=await entry.originalPrepareCall.apply(this,args);return {...call,stream:options=>stream(options,projected=>call.stream(projected))};};
     adapter.prepareCall=entry.prepareCall;
    }
    adapters.set(adapter,entry);adapter.stream=entry.stream;
   }
   attached.add(adapter);const existing=entry.sessions.get(sessionId);
   entry.sessions.set(sessionId,{count:(existing?.count??0)+1,prompt,toolPolicy,projectMessages,courseQuery});
  }
 };
 const unlisten=ctx.on('llm/adapters-updated',attach);attach();
 return ()=>{
  unlisten();
  for(const adapter of attached){
   const entry=adapters.get(adapter),own=entry.sessions.get(sessionId);
   if(--own.count===0)entry.sessions.delete(sessionId);
   if(!entry.sessions.size){if(adapter.stream===entry.stream)adapter.stream=entry.original;if(adapter.prepareCall===entry.prepareCall)adapter.prepareCall=entry.originalPrepareCall;adapters.delete(adapter);}
  }
 };
}
