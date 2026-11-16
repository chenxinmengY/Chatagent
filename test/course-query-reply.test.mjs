import test from 'node:test';
import assert from 'node:assert/strict';
import {formatCourseResult} from '../packages/dsh-bridge/course-query-reply.mjs';
import {createCourseQueryContext} from '../packages/dsh-bridge/course-query-context.mjs';
const course={date:'2026-11-11',weekday:'星期三',start:'08:15',end:'10:55',name:'大学物理实验C(2)',room:'综合实验大楼408',teacher:'代福'};
test('只输出结构化课表，忽略模型指导和结果中的闲聊；保留缺失字段和冲突',()=>{
 const input={status:'ok',courses:[course,{...course,name:'第二门课',room:null,teacher:null}],guidance:'主人快去睡觉',message:'去洗漱吧',conflicts:[{courses:[course,{...course,name:'冲突课'}]}]},before=JSON.stringify(input),value=formatCourseResult(input);
 assert.doesNotMatch(value,/主人|睡觉|洗漱/);assert.match(value,/08:15–10:55/);assert.match(value,/代福/);assert.match(value,/未填写/);assert.match(value,/课程时间冲突/);assert.match(value,/冲突课/);assert.equal(JSON.stringify(input),before);
 assert.match(formatCourseResult({...input,courses:[{...course,name:'a|b\n<script>**x**'}],conflicts:[]}),/a&#124;b &lt;script&gt;/);
});
test('无课、范围外、下一门课和详情歧义有固定的课表说明',()=>{
 for(const status of ['no_classes','no_remaining','no_future_in_dataset','out_of_coverage','reference_not_found','needs_clarification'])assert.ok(formatCourseResult({status,date:'2026-11-11',courses:[]}).length);
 const next=formatCourseResult({status:'ok',current:[course],courses:[{...course,date:'2026-11-12'}]});assert.match(next,/当前课程/);assert.match(next,/下一门课/);assert.match(next,/2026-11-12/);
 assert.throws(()=>formatCourseResult({status:'unknown',courses:[]}),/INVALID/);
});
test('只渲染本轮匹配的课表工具结果；错误不交给模型补写，旧轮次不重放',()=>{
 const events=[{type:'turn/start',data:{turn:1}},{type:'tool/call',data:{turn:1,name:'course-query__query',callId:'c'}},{type:'tool/result',data:{turn:1,message:{toolCallId:'other',content:[{type:'text',text:'OTHER'}]}}}],context=createCourseQueryContext({snapshotEvents:()=>events});
 assert.equal(context.reply(),undefined);
 events.push({type:'tool/result',data:{turn:1,message:{toolCallId:'c',content:[{type:'text',text:JSON.stringify({status:'ok',courses:[course]})}]}}});assert.match(context.reply(),/大学物理实验/);
 events.at(-1).data.message.isError=true;assert.equal(context.reply(),'课表查询失败，请稍后重试。');events.push({type:'turn/end',data:{turn:1}});assert.equal(context.reply(),undefined);
});
