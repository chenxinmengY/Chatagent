import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_MEDIA_SETTINGS={version:1,timezone:'Asia/Shanghai',video:{enabled:true,dailyRounds:3,roundMinutes:20,dailyMinutes:60,tokenLimit:2000000,windows:[{start:'12:30',end:'14:30'}],allowIdleOutsideWindows:true,idleMinutes:30,gapMinutes:30},music:{enabled:true,dailyRounds:5,roundMinutes:5,dailyMinutes:25,windows:[{start:'12:30',end:'14:30'}],allowIdleOutsideWindows:true,idleMinutes:30,gapMinutes:30}};
const clone=value=>structuredClone(value);
const fault=message=>Object.assign(Error(message),{status:400});
const minute=value=>{if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))throw fault('时间请使用 HH:mm 格式。');const [h,m]=value.split(':').map(Number);return h*60+m;};
export function validateMediaSettings(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||value.timezone!=='Asia/Shanghai'||Object.keys(value).some(k=>!['version','timezone','video','music'].includes(k)))throw fault('音视频配置格式无效。');
 for(const kind of ['video','music']){
  const x=value[kind],keys=Object.keys(DEFAULT_MEDIA_SETTINGS[kind]);
  if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).length!==keys.length||keys.some(k=>!Object.hasOwn(x,k)))throw fault('请提供完整的视频与音乐配置。');
  if(typeof x.enabled!=='boolean'||typeof x.allowIdleOutsideWindows!=='boolean')throw fault('开关值无效。');
  for(const [key,min,max] of [['dailyRounds',0,kind==='video'?20:50],['roundMinutes',1,kind==='video'?120:5],['dailyMinutes',0,1440],['idleMinutes',1,1440],['gapMinutes',1,1440],...(kind==='video'?[['tokenLimit',10000,20000000]]:[])])if(!Number.isSafeInteger(x[key])||x[key]<min||x[key]>max)throw fault(`${kind==='video'?'视频':'音乐'}的 ${key} 超出可设置范围。`);
  if(!Array.isArray(x.windows)||x.windows.length>8)throw fault('每天最多设置8个时间段。');
  for(const w of x.windows){if(!w||typeof w!=='object'||Object.keys(w).sort().join(',')!=='end,start'||minute(w.start)===minute(w.end))throw fault('时间段的开始和结束不能相同。');}
 }
 return clone(value);
}
const fileFor=root=>path.join(root,'config/media-settings.json');
export function readMediaSettings(root){const file=fileFor(root);if(!fs.existsSync(file))return clone(DEFAULT_MEDIA_SETTINGS);const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw fault('音视频配置文件无效，已停止自主活动。');return validateMediaSettings(JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')));}
export function mediaSettingsRevision(root){const file=fileFor(root);return crypto.createHash('sha256').update(fs.existsSync(file)?fs.readFileSync(file):JSON.stringify(DEFAULT_MEDIA_SETTINGS)).digest('hex');}
export function saveMediaSettings(root,value,revision){const settings=validateMediaSettings(value);if(typeof revision!=='string'||revision!==mediaSettingsRevision(root))throw Object.assign(Error('配置已变化，请刷新后再保存。'),{status:409});const file=fileFor(root),tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.mkdirSync(path.dirname(file),{recursive:true});const fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(settings,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}try{fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}return {settings,revision:mediaSettingsRevision(root)};}
const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
export function mediaClock(at){const p=Object.fromEntries(parts.formatToParts(new Date(at)).map(x=>[x.type,x.value]));return {day:`${p.year}-${p.month}-${p.day}`,minute:Number(p.hour)*60+Number(p.minute)};}
export function insideMediaWindow(settings,at){const t=mediaClock(at).minute;return settings.windows.some(w=>{const a=minute(w.start),b=minute(w.end);return a<b?t>=a&&t<b:t>=a||t<b;});}
export function mediaScheduleDue(settings,{now,lastStart=0,lastChat=0,stoppedAt=0}){if(!settings.enabled||!settings.dailyRounds||!settings.dailyMinutes||now<lastStart||lastChat>now||stoppedAt&&lastChat<=stoppedAt||now-lastStart<settings.gapMinutes*60000)return false;return insideMediaWindow(settings,now)||settings.allowIdleOutsideWindows&&lastChat>0&&now-Math.max(lastChat,lastStart)>=settings.idleMinutes*60000;}
