import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const tool='daily-reminders__manage';
const textOf=message=>(message?.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
const parse=value=>{try{return typeof value==='string'?JSON.parse(value):value;}catch{return null;}};
const recurring=p=>['daily','weekly'].includes(parse(p?.schedule)?.kind);
const explicit=text=>/提醒|叫我|闹钟|到点/.test(text)&&/每天|每日|每晚|每早|每周|每星期|每个星期|长期|重复|以后|今后/.test(text);
const alias=id=>'reminder-once:'+id;
export function projectReminderHistory(rows,policy){
 if(!policy)return rows;
 const ids=new Set(policy.excludedRequestIds),users=new Set(policy.excludedUserRequestIds),messages=new Set(policy.excludedMessageIds),replacements=new Map(policy.replacements);
 return rows.flatMap(row=>{
  if(row.role==='user'?users.has(row.id):ids.has(row.contextParent))return [];
  if(replacements.has(row.id))return [{...row,text:replacements.get(row.id)}];
  return messages.has(row.id)?[]:[row];
 });
}

// Scheduling remains authoritative. This is a read-only projection for model
// inputs; it never changes a reminder, receipt, archive, diary or user timeline.
export function createReminderContext(session,{root,chatFile,imported=()=>[],exclusions}={}){
 if(exclusions&&exclusions.sessionId!==session.id)throw Error('CHAT_CONTEXT_EXCLUSIONS_INVALID');
 const redactions=new Map((exclusions?.reminderRedactions??[]).map(r=>[r.id,r.remove]));
 const bindingFile=root&&path.join(root,'chatagent-binding.json'),binding=bindingFile&&fs.existsSync(bindingFile)?JSON.parse(fs.readFileSync(bindingFile,'utf8')):null;
 if(binding&&binding.sessionId!==session.id)throw Error('LOCAL_PLUGIN_SESSION_MISMATCH');
 if(binding&&(!/^[a-f0-9]{64}$/.test(binding.account??'')||!/^wechat:private:[1-9]\d*$/.test(binding.key??'')))throw Error('PLUGIN_ARCHIVE_SCOPE_INVALID');
 const database=binding&&path.join(root,'state/reminders',binding.account,'reminders.sqlite');
 const clean=(text,id)=>{const parts=redactions.get(id);if(!parts)return text;for(const part of parts)text=text.replaceAll(part,'');return text.trim();};
 const withDb=(file,fn,fallback)=>{if(!file||!fs.existsSync(file))return fallback;const db=new DatabaseSync(file,{readOnly:true});try{return fn(db);}finally{db.close();}};
 function snapshot(){
  const plans=withDb(database,db=>db.prepare('SELECT id,schedule FROM plans WHERE chat=?').all(binding.key),[]),byPlan=new Map(plans.map(p=>['R'+String(p.id).padStart(2,'0'),p]));
  const batches=withDb(database,db=>db.prepare('SELECT b.id,b.text,o.phrase,p.schedule FROM batches b JOIN occurrences o ON o.batch=b.id JOIN plans p ON p.id=o.plan WHERE b.chat=? ORDER BY b.created,o.plan,o.id').all(binding.key),[]),groups=new Map();
  for(const item of batches){if(!groups.has(item.id))groups.set(item.id,[]);groups.get(item.id).push(item);}
  const deliveries=new Map(),oldTexts=new Map();
  for(const [id,items]of groups){if(!items.some(recurring))continue;const once=items.filter(item=>!recurring(item));
   const original=items[0].text,heading=original.split('\n')[0],text=once.length?heading+'\n'+once.map((item,i)=>once.length>1?`${i+1}. ${item.phrase}`:item.phrase).join('\n'):'';
   deliveries.set('reminder-'+id,text);oldTexts.set(original.trim(),text);
   for(const item of items.filter(recurring))oldTexts.set(item.phrase.trim(),'');
  }
  const messageIds=new Set(),replacements=new Map();
  for(const row of withDb(chatFile,db=>db.prepare("SELECT id,client_id FROM messages WHERE device='plugin-delivery' AND client_id LIKE 'reminder-%'").all(),[])){
   if(!deliveries.has(row.client_id))continue;messageIds.add(row.id);if(deliveries.get(row.client_id))replacements.set(row.id,deliveries.get(row.client_id));
  }
  const events=session.snapshotEvents(),ended=new Set(),turns=new Set(),intents=new Set(),users=[],calls=new Map();let current;
  for(const e of events){
   if(e.type==='turn/start')current=e.data.turn;
   if(e.type==='turn/end')ended.add(e.data.turn);
   if(e.type==='user/message'&&e.data.source?.kind==='user'){users.push({event:e,turn:current});if(explicit(textOf(e.data)))intents.add(current);}
   if(e.type==='tool/call'&&e.data.name===tool){const args=parse(e.data.arguments)??{};calls.set(e.data.callId,e.data.turn);
    if(['daily','weekly'].includes(args.repeat)||recurring(byPlan.get(args.planId?.toUpperCase()))||args.action==='list'&&(args.kind==='repeating'||args.kind!=='once'&&plans.some(recurring)))turns.add(e.data.turn);
   }
   if(e.type==='tool/result'&&calls.has(e.data.message?.toolCallId)){
    let result=parse(textOf(e.data.message));if(typeof result?.text==='string')result=parse(result.text);
    if(recurring(result?.plan)||(result?.plans??[]).some(recurring)||(result?.recent??[]).some(o=>recurring(byPlan.get(o.planId?.toUpperCase()))))turns.add(calls.get(e.data.message.toolCallId));
   }
  }
  const completed=new Set([...turns].filter(turn=>ended.has(turn))),requestIds=new Set(users.filter(u=>completed.has(u.turn)).map(u=>u.event.data.source.rpcId).filter(Boolean));
  const requestUsers=users.filter(u=>completed.has(u.turn)&&(explicit(textOf(u.event.data))||/提醒|R\d+/i.test(textOf(u.event.data)))),userIds=new Set(requestUsers.map(u=>u.event.data.source.rpcId).filter(Boolean));
  const recordIds=new Set(redactions.keys()),nativeIds=new Set();
  for(const e of events)if(completed.has(e.data.turn)&&['assistant/message','tool/result'].includes(e.type)){if(e.data.message?.id)nativeIds.add(e.data.message.id);if(e.type==='assistant/message')recordIds.add('native:'+session.id+':'+e.seq);}
  for(const u of requestUsers){recordIds.add('native:'+session.id+':'+u.event.seq);if(u.event.data.id)nativeIds.add(u.event.data.id);}
  for(const row of imported())if(row.kind==='message'&&row.role==='assistant'&&oldTexts.has(row.text.trim()))recordIds.add(JSON.stringify([row.sourceId,row.scope,row.id]));
  return {recordIds,nativeIds,requestIds,userIds,messageIds,replacements,oldTexts,turns,intents,ended,current};
 }
 function records(rows){const state=snapshot();return rows.flatMap(row=>{
  let text=clean(row.text,row.id);
  if(state.recordIds.has(row.id)&&!redactions.has(row.id)){
   const replacement=state.oldTexts.get(row.text.trim());return replacement?[{...row,id:alias(row.id),text:replacement}]:[];
  }
  return text?[{...row,...text!==row.text?{id:alias(row.id),text}:{}}]:[];
 });}
 function status(){const s=snapshot();return {rule:'recurring-reminders-outside-chat-context',excludedRequestIds:[...s.requestIds],excludedUserRequestIds:[...s.userIds],excludedMessageIds:[...s.messageIds],replacements:[...s.replacements]};}
 return {
  records,recordIds:()=>snapshot().recordIds,status,
  filterHistory(rows){const s=snapshot(),filtered=projectReminderHistory(rows,{excludedRequestIds:s.requestIds,excludedUserRequestIds:s.userIds,excludedMessageIds:s.messageIds,replacements:s.replacements});return filtered.flatMap(row=>{const id=row.kind==='message'?JSON.stringify([row.sourceId,row.scope,row.id]):row.id,text=clean(row.text,id);if(row.kind==='message'&&row.role==='assistant'&&s.oldTexts.has(text.trim())){const value=s.oldTexts.get(text.trim());return value?[{...row,text:value}]:[];}return text?[{...row,text}]:[];});},
  project(messages){const s=snapshot();return messages.filter(m=>!s.nativeIds.has(m.id));},
  permits(name){if(name!=='remember')return true;const s=snapshot();return !(s.turns.has(s.current)||s.intents.has(s.current))||s.ended.has(s.current);},
  diaryText(record,text){return clean(text,'diary:'+record?.id);}
 };
}
