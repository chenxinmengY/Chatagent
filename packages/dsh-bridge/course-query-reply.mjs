// Course facts are rendered locally. Personal chat and model prose never take
// part in the displayed result, including a preamble before a tool call.
export const COURSE_QUERY_PROMPT='你是课表查询参数解析器。只依据本轮用户问题和当前时间调用 course-query__query，不闲聊、不调用其他工具、不自行编造课程。未指定日期的课表查询用 day/today；下节课用 next；课程追问用 details 的 reference/name/ordinal。工具会在当前会话保留上次查询引用。只发起工具调用，查询结果由程序直接显示。';
const text=value=>[{type:'text',text:value}];
const cell=value=>String(value??'未填写').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\|/g,'&#124;').replace(/[\r\n]+/g,' ').replace(/([\\`*\[\]])/g,'\\$1');
const table=courses=>['| 日期 | 时间 | 课程 | 地点 | 老师 |','| --- | --- | --- | --- | --- |',...courses.map(c=>'| '+[c.date+(c.weekday?' '+c.weekday:''),c.start+'–'+c.end,c.name,c.room,c.teacher].map(cell).join(' | ')+' |')].join('\n');
const notices={no_classes:'没有安排课程。',no_remaining:'没有剩余课程。',no_future_in_dataset:'已导入课表没有之后的课程。',out_of_coverage:'该日期超出已导入课表范围。',reference_not_found:'请提供课程名和日期，或先查询课表。',needs_clarification:'请确认要查询哪一门课程。'};
export function formatCourseResult(result){
 if(!result||!['ok',...Object.keys(notices)].includes(result.status)||!Array.isArray(result.courses))throw Error('COURSE_RESULT_INVALID');
 const parts=[];
 if(notices[result.status])parts.push((result.date?cell(result.date)+'：':'')+notices[result.status]);
 if(result.current?.length)parts.push('当前课程：\n\n'+table(result.current));
 if(result.courses.length)parts.push((Object.hasOwn(result,'current')?'下一门课：\n\n':'')+table(result.courses));
 for(const conflict of result.conflicts??[])parts.push('课程时间冲突：\n\n'+table(conflict.courses));
 if(!parts.length)throw Error('COURSE_RESULT_EMPTY');
 return parts.join('\n\n');
}
export function projectCourseQuery(messages){
 const start=messages.findLastIndex(m=>m.role==='user'&&m.source?.kind==='user');
 if(start<0)throw Error('COURSE_QUERY_INPUT_MISSING');
 const time=messages.flatMap(m=>m.source?.kind==='runtime-context'?(m.source.sections??[]).filter(s=>s.name==='time-context'):[]);
 return [{role:'system',source:{kind:'system-prompt'},content:text(COURSE_QUERY_PROMPT)},...time.length?[{role:'developer',source:{kind:'runtime-context',sections:time},content:text(time.map(s=>s.text).join('\n'))}]:[],...messages.slice(start).filter((m,i)=>i===0||['assistant','tool'].includes(m.role))];
}
export async function* courseTextStream(value){
 yield {type:'block-start',index:0,blockType:'text'};
 yield {type:'block-end',index:0,block:{type:'text',text:value}};
 yield {type:'finish',reason:{kind:'stop'}};
}
export async function* courseCallStream(stream){
 const blocks=[];let finish;
 for await(const event of stream){
  if(event.type==='block-end'&&event.block?.type==='tool-call')blocks.push(event.block);
  else if(event.type==='finish')finish=event;
 }
 if(!blocks.length){yield* courseTextStream('请说明要查询的日期或课程。');return;}
 for(const [index,block] of blocks.entries()){
  yield {type:'block-start',index,blockType:'tool-call'};
  yield {type:'block-end',index,block};
 }
 yield {...finish,type:'finish',reason:{kind:'tool-calls'}};
}
