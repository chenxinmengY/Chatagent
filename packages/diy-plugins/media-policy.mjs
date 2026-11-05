// Match WeChatAgent's autonomous-activity controls; explicit invitations are separate.
export const policyDefaults={roundMinutes:20,dailyMinutes:60,tokenLimit:2000000,idleMinutes:30,windows:[{start:'12:30',end:'14:30'}],allowIdleOutsideWindows:true};
export function mediaSettings(value){
 const next={...structuredClone(policyDefaults),...value};
 if(!value.windows&&value.quietStart!==undefined){const time=h=>String(h).padStart(2,'0')+':00';next.windows=value.quietStart===value.quietEnd?[{start:'00:00',end:'23:59'}]:[{start:time(value.quietEnd),end:time(value.quietStart)}];next.allowIdleOutsideWindows=false;}
 return next;
}
const minute=value=>{if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))throw Error('PLUGIN_SETTINGS_INVALID');const [h,m]=value.split(':').map(Number);return h*60+m;};
export function validateMediaPolicy(value){
 for(const [key,min,max] of [['roundMinutes',1,120],['dailyMinutes',0,1440],['tokenLimit',10000,20000000],['idleMinutes',1,1440],['intervalMinutes',1,1440],['maxPerDay',0,20]])if(!Number.isSafeInteger(value[key])||value[key]<min||value[key]>max)throw Error('PLUGIN_SETTINGS_INVALID');
 if(typeof value.allowIdleOutsideWindows!=='boolean'||!Array.isArray(value.windows)||value.windows.length>8)throw Error('PLUGIN_SETTINGS_INVALID');
 for(const window of value.windows)if(!window||Object.keys(window).sort().join(',')!=='end,start'||minute(window.start)===minute(window.end))throw Error('PLUGIN_SETTINGS_INVALID');
}
export function scheduleDue(value,{now,lastStart=0,lastChat=0,stoppedAt=0}){
 if(!value.enabled||!value.automatic||!value.maxPerDay||!value.dailyMinutes||now<lastStart||lastChat>now||stoppedAt&&lastChat<=stoppedAt||now-lastStart<value.intervalMinutes*60000)return false;
 const time=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now),at=minute(time);
 const inside=value.windows.some(w=>{const start=minute(w.start),end=minute(w.end);return start<end?at>=start&&at<end:at>=start||at<end;});
 return inside||value.allowIdleOutsideWindows&&lastChat>0&&now-Math.max(lastChat,lastStart)>=value.idleMinutes*60000;
}
export function tokenTotal(usage){
 if(!usage||typeof usage!=='object')return null;
 const values=['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'].map(k=>usage[k]??0);
 if(values.some(v=>!Number.isFinite(v)||v<0))return null;
 if(Number.isFinite(usage.totalTokens)&&usage.totalTokens>=0)return usage.totalTokens;
 return Number.isFinite(usage.inputTokens)&&Number.isFinite(usage.outputTokens)?values.reduce((a,b)=>a+b,0):null;
}
