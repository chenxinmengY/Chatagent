import {invitation,isMusicStop,explicitRelisten} from './intent.mjs';
export function musicTurnDescriptor(rows,key){
 if(!/^wechat:private:[1-9]\d{0,15}$/.test(key)||!Array.isArray(rows))return undefined;
 const latest=rows.filter(r=>!r.outgoing&&r.interaction!=='pat').at(-1);
 if(latest?.forwardedRecord||latest?.quoteReply)return {version:1,stop:false,mentions:[],blocked:true};
 const inbound=rows.filter(r=>!r.outgoing&&!r.forwardedRecord&&!r.quoteReply&&r.interaction!=='pat'&&typeof r.text==='string'),last=inbound.at(-1);
 if(!last)return undefined;
 const stop=isMusicStop(last.text);
 const found=inbound.map(r=>({r,bvid:invitation(r.text)})).filter(x=>x.bvid),bvids=[...new Set(found.map(x=>x.bvid))];
 const value={version:1,stop,relistenRequested:explicitRelisten(last.text),mentions:[...new Set(inbound.flatMap(r=>r.text.match(/BV[1-9A-HJ-NP-Za-km-z]{10}/g)??[]))].slice(0,10)};
 const x=!stop&&bvids.length===1&&value.mentions.length===1?found.at(-1):null;
 if(x&&typeof x.r.message_id==='string'&&x.r.message_id.length<=200&&Number.isFinite(x.r.timestamp))value.invitation={bvid:x.bvid,messageId:x.r.message_id,createdAt:x.r.timestamp*1000};
 return value;
}
export function checkedDescriptor(v,{now=Date.now()}={}){
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['version','stop','mentions','invitation','blocked','relistenRequested'].includes(k))||v.version!==1||typeof v.stop!=='boolean'||v.blocked!==undefined&&typeof v.blocked!=='boolean'||v.relistenRequested!==undefined&&typeof v.relistenRequested!=='boolean'||!Array.isArray(v.mentions)||v.mentions.length>10||v.mentions.some(x=>!/^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(x)))throw Error('MUSIC_DESCRIPTOR_INVALID');
 const i=v.invitation;
 if(i&&(v.stop||v.blocked||v.mentions.length!==1||!/^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(i.bvid??'')||!v.mentions.includes(i.bvid)||typeof i.messageId!=='string'||!i.messageId||i.messageId.length>200||!Number.isFinite(i.createdAt)||i.createdAt>now+5000||now-i.createdAt>300000||Object.keys(i).some(k=>!['bvid','messageId','createdAt'].includes(k))))throw Error('MUSIC_DESCRIPTOR_INVALID');
 return {stop:v.stop,mentions:[...v.mentions],blocked:v.blocked===true,relistenRequested:v.relistenRequested===true,invitation:i?{...i}:null};
}
