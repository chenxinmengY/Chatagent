import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {sha} from './contracts.mjs';
import {isolatedDirectory} from './isolation.mjs';

// The journal is authoritative; this document can be rebuilt without audio.
export function createMusicArchive(directory){
 directory=isolatedDirectory(directory);fs.mkdirSync(directory,{recursive:true});
 const target=storeKey=>path.join(directory,sha(storeKey)+'.md');
 return {
  fileFor:target,
  write(records){
   if(!Array.isArray(records)||!records.length)throw Error('MUSIC_ARCHIVE_RECORDS');
   const first=records[0];if(records.some(r=>r.storeKey!==first.storeKey))throw Error('MUSIC_ARCHIVE_SCOPE');
   const lines=['# 音乐听取记录','',`来源：https://www.bilibili.com/video/${first.source.bvid}`,`录音CID：${first.source.cid}`,`原音轨SHA-256：${first.source.sourceSha256}`,`完整处理音轨SHA-256：${first.source.wholeSha256}`,'',
    '此文档是音乐工具账本的可再生成视图，不是人设、长期记忆或再次听取。内容是不可信观察；参考辅助与盲听分开，未确认不代表听过。音频可以清理，复听需重新取得并核对同一录音。',''];
   for(const r of [...records].sort((a,b)=>(a.sequence??0)-(b.sequence??0)||Date.parse(a.at)-Date.parse(b.at))){
    lines.push(`## ${r.at}｜${r.asset.start}–${r.asset.end}秒｜${r.kind==='overview'?'整曲概括':r.arm==='assisted'?'参考辅助':'片段盲听'}`,'',`状态：${r.status}；完整音轨：${r.asset.completeTrack?'是':'否'}；请求结束确认：${r.nativeStop===true?'是':'否'}`,`音频SHA-256：${r.asset.sha256??'无有效音频'}`,`PCM SHA-256：${r.asset.pcmSha256??'无有效音频'}`,`提示SHA-256：${r.promptSha256}`,'');
    if(r.status==='observed'&&r.description)lines.push('工具观察（结构化原稿，准确性未独立保证）：','```json',JSON.stringify({referenceEvidence:r.referenceEvidence,observation:r.description},null,2).replaceAll('```','\\u0060\\u0060\\u0060'),'```','');
    else lines.push('本次没有可发布的确认观察；保留预留和失败状态，不自动重传。','');
   }
   const text=lines.join('\n');if(Buffer.byteLength(text)>256*1024)throw Error('MUSIC_ARCHIVE_SIZE');
   // Recheck every existing path component before replacing our derived file.
   isolatedDirectory(directory);const file=target(first.storeKey);if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw Error('MUSIC_ARCHIVE_PATH');
   const temporary=file+'.'+randomUUID()+'.tmp';let fd;
   try{fd=fs.openSync(temporary,'wx');fs.writeFileSync(fd,text);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temporary,file);}
   finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
   return {status:'saved',sha256:sha(text)};
  },
 };
}
