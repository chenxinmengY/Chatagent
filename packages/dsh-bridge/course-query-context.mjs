import {formatCourseResult} from './course-query-reply.mjs';
// Scope by recorded tool provenance, never by words in ordinary conversation.
const courseTool='course-query__query';
const calls=message=>[...(message?.toolCalls??[]),...(message?.content??[]).filter(b=>b.type==='tool-call')];
const textOf=event=>(event.data.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
const queryFollowup=value=>/^(?:那|再|帮我)?(?:查一次|查一下|查查|今天|明天|后天|昨天|下周|周[一二三四五六日天]|星期[一二三四五六日天])(?:呢|的|吧|[?？。!！])?$/.test(value);
function explicitQuery(value){
 const topic=/课表|课程表|课程安排|上课时间|下课时间|早[八8]|教室|(?:什么|啥|哪些|哪门|哪节|几节).{0,6}课|(?:何时|什么时候|几点).{0,6}(?:上课|下课)|课.{0,6}(?:几点|何时|什么时候|在哪|哪里|哪间|哪栋|老师|是谁)|(?:今天|明天|后天|周[一二三四五六日天]).{0,8}有课|timetable|class schedule|what classes|when.{0,20}class/i;
 return topic.test(value)&&/[?？]|查|看|问|几|哪|什么|啥|何|是否|有没有|吗|么|发|给|列|告诉|安排|show|check|what|when|schedule|timetable/i.test(value);
}
const normalized=value=>String(value??'').normalize('NFKC').trim();
export function createCourseQueryContext(session,exclusions){
 if(exclusions && exclusions.sessionId!==session.id)throw Error('CHAT_CONTEXT_EXCLUSIONS_INVALID');
 const echoes=new Set(exclusions?.courseEchoRecordIds??[]);
 const deliveredEchoes=new Set(exclusions?.courseEchoMessageIds??[]);
 function provenance(){
  const events=session.snapshotEvents(),turns=new Set(),ended=new Set(),requests=[],users=[];let current;
  for(const e of events){
   if(e.type==='turn/start')current=e.data.turn;
   if(e.type==='turn/end')ended.add(e.data.turn);
   if(e.type==='user/message'&&e.data.source?.kind==='user'){users.push({turn:current,event:e});if(e.data.source.rpcId)requests.push({turn:current,id:e.data.source.rpcId});}
   if(e.type==='tool/call'&&e.data.name===courseTool||e.type==='assistant/message'&&calls(e.data.message).some(c=>c.name===courseTool))turns.add(e.data.turn);
  }
  // A model-initiated lookup after "早" must not turn that greeting into a lookup question.
  const inputs=[];for(let i=0;i<users.length;i++){const u=users[i],value=normalized(textOf(u.event));if(turns.has(u.turn)&&(explicitQuery(value)||i>0&&inputs.at(-1)===users[i-1]&&queryFollowup(value)))inputs.push(u);}
  return {events,turns,ended,current,users,inputs,requestIds:requests.filter(r=>turns.has(r.turn)).map(r=>r.id)};
 }
 return {
  recordIds(){const {events,turns,inputs}=provenance();return new Set([...echoes,...[...events.filter(e=>e.type==='assistant/message'&&turns.has(e.data.turn)),...inputs.map(u=>u.event)].map(e=>'native:'+session.id+':'+e.seq)]);},
  excludedAssistantMessageIds(){return [...deliveredEchoes];},
  requestIds(){return provenance().requestIds;},
  userRequestIds(){return provenance().inputs.map(u=>u.event.data.source.rpcId).filter(Boolean);},
  queried(){const {turns,current}=provenance();return turns.has(current);},
  reply(){
   const {events,current,ended}=provenance();if(ended.has(current))return;
   const ids=new Set(events.filter(e=>e.type==='tool/call'&&e.data.turn===current&&e.data.name===courseTool).map(e=>e.data.callId));
   const results=events.filter(e=>e.type==='tool/result'&&e.data.turn===current&&ids.has(e.data.message.toolCallId));
   if(!results.length)return;
   return results.map(e=>{try{if(e.data.message.isError)throw Error('COURSE_QUERY_FAILED');return formatCourseResult(JSON.parse(e.data.message.content.filter(b=>b.type==='text').map(b=>b.text).join('')));}catch{return '课表查询失败，请稍后重试。';}}).join('\n\n');
  },
  filterHistory(rows){const p=provenance(),ids=new Set(p.requestIds),users=new Set(p.inputs.map(u=>u.event.data.source.rpcId));return rows.filter(r=>r.role==='user'?!users.has(r.id):!ids.has(r.contextParent)&&!deliveredEchoes.has(r.id));},
  requestsQuery(text){
   const value=normalized(text);if(explicitQuery(value))return true;
   const {users,inputs}=provenance(),last=users.at(-1);
   return !!last&&inputs.at(-1)===last&&queryFollowup(value);
  },
  permits(name){if(name!=='remember')return true;const {turns,ended,current}=provenance();return !turns.has(current)||ended.has(current);},
  project(messages){
   const {events,turns,ended,inputs}=provenance();
   const ids=new Set([...events.filter(e=>['assistant/message','tool/result'].includes(e.type)&&turns.has(e.data.turn)&&ended.has(e.data.turn)).map(e=>e.data.message.id),...inputs.filter(u=>ended.has(u.turn)).map(u=>u.event.data.id)].filter(Boolean));
   for(const event of events)if(event.type==='assistant/message'&&echoes.has('native:'+session.id+':'+event.seq))ids.add(event.data.message.id);
   return messages.filter(m=>!ids.has(m.id));
  }
 };
}
