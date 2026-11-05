import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid=()=>{throw Error('PLUGIN_TIMETABLE_INVALID');};
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const time=value=>typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
export function validateTimetable(value){
 if(!value||value.schemaVersion!==1||value.timezone!=='Asia/Shanghai'||!Array.isArray(value.courses)||!value.courses.length||value.courses.length>3000||!Array.isArray(value.coveredDates)||!value.coveredDates.length||value.coveredDates.length>1500||value.coveredDates.some(d=>!date(d))||!Array.isArray(value.bells)||!value.bells.length||value.bells.length>24)invalid();
 const bells=value.bells.map(b=>{if(!Number.isInteger(b.period)||b.period<1||b.period>24||!time(b.start)||!time(b.end)||b.start>=b.end)invalid();return {period:b.period,start:b.start,end:b.end};});
 if(new Set(bells.map(b=>b.period)).size!==bells.length)invalid();
 const ids=new Set(),coveredDates=[...new Set(value.coveredDates)].sort(),courses=value.courses.map(c=>{
  if(!c||typeof c.id!=='string'||!c.id||c.id.length>80||ids.has(c.id)||!date(c.date)||!coveredDates.includes(c.date)||typeof c.name!=='string'||!c.name.trim()||c.name.length>120||!time(c.start)||!time(c.end)||c.start>=c.end||!Array.isArray(c.periods)||!c.periods.length||c.periods.some(p=>!bells.some(b=>b.period===p)))invalid();
  ids.add(c.id);const out={id:c.id,date:c.date,name:c.name.trim(),start:c.start,end:c.end,periods:[...new Set(c.periods)].sort((a,b)=>a-b)};
  for(const key of ['kind','teacher','room']){if(c[key]!=null&&(typeof c[key]!=='string'||c[key].length>200))invalid();out[key]=c[key]??'';}
  return out;
 }).sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start)||a.id.localeCompare(b.id));
 const conflicts=[];for(let i=0;i<courses.length;i++)for(let j=i+1;j<courses.length&&courses[j].date===courses[i].date;j++){const a=courses[i],b=courses[j];if(a.start<b.end&&b.start<a.end)conflicts.push({date:a.date,courseIds:[a.id,b.id],periods:a.periods.filter(p=>b.periods.includes(p))});if(conflicts.length>3000)invalid();}
 const result={schemaVersion:1,timezone:'Asia/Shanghai',sourceName:String(value.sourceName??'导入课表').slice(0,120),bells,coveredDates,courses,conflicts};result.revision=hash(result);return result;
}
function csvRows(text){
 const rows=[];let row=[],cell='',quoted=false;
 for(let i=0;i<text.length;i++){const ch=text[i];if(ch==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else if(quoted||!cell)quoted=!quoted;else invalid();}else if(!quoted&&(ch===','||ch==='\n'||ch==='\r')){row.push(cell);cell='';if(ch!==','){if(row.some(c=>c.trim()))rows.push(row);row=[];if(ch==='\r'&&text[i+1]==='\n')i++;}}else cell+=ch;}
 if(quoted)invalid();row.push(cell);if(row.some(c=>c.trim()))rows.push(row);return rows;
}
export function importTimetable(text,format,current,name){
 let value;
 if(format==='json'){try{value=JSON.parse(text.replace(/^\uFEFF/,''));}catch{invalid();}}
 else if(format==='csv'){
  const [header,...rows]=csvRows(text.replace(/^\uFEFF/,'')),columns=['日期','课程','开始','结束','节次','教师','教室'];if(!header||header.length!==7||header.some((c,i)=>c.trim()!==columns[i]))invalid();
  const courses=rows.map((r,i)=>{if(r.length!==7)invalid();return {id:'import-'+i,date:r[0].trim(),name:r[1].trim(),start:r[2].trim(),end:r[3].trim(),periods:r[4].trim().split(/[;；、 ]+/).map(Number),teacher:r[5].trim(),room:r[6].trim()};});
  value={schemaVersion:1,timezone:'Asia/Shanghai',bells:current.bells,coveredDates:[...new Set(courses.map(c=>c.date))],courses};
 }else invalid();
 return validateTimetable({...value,sourceName:name??value.sourceName});
}
export function createCourseTimetable({root,reload=async()=>{},busy=()=>false,python='python'}){
 const file=path.join(root,'plugins/course-query/assets/timetable.json'),directory=path.join(root,'state/course-imports');
 const read=()=>{const data=JSON.parse(fs.readFileSync(file,'utf8'));return {...data,revision:hash(data)};};
 async function preview(body){
  if(typeof body.content!=='string'||body.content.length>4*1024*1024)invalid();
  const current=read();let data;
  if(body.format==='xlsx'){
   fs.mkdirSync(directory,{recursive:true});const work=fs.mkdtempSync(path.join(directory,'preview-'));try{
    const bytes=Buffer.from(body.content,'base64');if(bytes.length>3*1024*1024||bytes.subarray(0,2).toString()!=='PK')invalid();
    const source=path.join(work,'timetable.xlsx'),output=path.join(work,'out.json'),report=path.join(work,'report.json');fs.writeFileSync(source,bytes);
    try{await promisify(execFile)(python,[fileURLToPath(new URL('./import-timetable.py',import.meta.url)),source,'--output',output,'--report',report],{windowsHide:true,timeout:10000,maxBuffer:65536});}catch{throw Error('PLUGIN_TIMETABLE_XLSX_INVALID');}
    data=validateTimetable({...JSON.parse(fs.readFileSync(output,'utf8')),sourceName:body.name});
   }finally{fs.rmSync(work,{recursive:true,force:true});}
  }else data=importTimetable(body.content,body.format,current,body.name);
  return {revision:current.revision,preview:hash([current.revision,data]),data,report:{courses:data.courses.length,dates:data.coveredDates.length,conflicts:data.conflicts.length,from:data.coveredDates[0],to:data.coveredDates.at(-1)}};
 }
 return {read,status(){const d=read();return {id:'course-query',name:'课表查询',description:'查看个人课表，导入和更新课程、教室、任课教师。',settings:{enabled:true,revision:d.revision},courseCount:d.courses.length,coverage:[d.coveredDates[0],d.coveredDates.at(-1)]};},async action(action,body){
  if(action==='preview')return preview(body);
  if(action!=='apply')throw Error('PLUGIN_ACTION_INVALID');if(busy())throw Error('PLUGIN_BUSY');
  const old=JSON.parse(fs.readFileSync(file,'utf8')),revision=hash(old),data=validateTimetable(body.data);
  if(body.revision!==revision||body.preview!==hash([revision,data]))throw Error('PLUGIN_SETTINGS_CHANGED');
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,Date.now()+'-'+randomUUID()+'.json'),JSON.stringify(old),{flag:'wx',mode:0o600});
  const write=value=>{const tmp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});fs.renameSync(tmp,file);};
  write(data);try{await reload();}catch{write(old);await reload();throw Error('PLUGIN_TIMETABLE_RELOAD_FAILED');}return {saved:true,...this.status()};
 }};
}
