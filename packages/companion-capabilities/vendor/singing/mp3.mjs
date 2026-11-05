import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {atomic,read,regular,fileSha} from './common.mjs';
const exec=promisify(execFile);
const md5=file=>crypto.createHash('md5').update(fs.readFileSync(regular(file))).digest('hex');
export function checkedMp3(manifest) {
  const record=read(regular(manifest)),file=regular(path.join(path.dirname(manifest),'cover.mp3'));
  if(record.schema!=='singing-mp3-v1'||record.file!==file||record.codec!=='mp3'||record.sampleRate!==44100||record.channels!==2||record.bitRate!==320000||record.fullDecode!==true||!Number.isSafeInteger(record.sourceFrames)||record.sourceFrames<=0||!Number.isFinite(record.durationSeconds)||Math.abs(record.durationSeconds-record.sourceFrames/44100)>.15||record.bytes!==fs.statSync(file).size||record.bytes<=0||record.bytes>50*1024*1024||fileSha(file)!==record.sha256||md5(file)!==record.md5)throw Error('SINGING_MP3_INVALID');
  return {parts:[{index:1,kind:'mp3',file,sha256:record.sha256,md5:record.md5,size:record.bytes,name:record.name,durationMs:Math.round(record.sourceFrames/44.1)}],frames:record.sourceFrames,manifestSha256:fileSha(manifest)};
}
export function createMp3Encoder({directory,ffmpeg='ffmpeg',ffprobe='ffprobe'}) {
  return async function encode({id,bvid,title,master,signal}) {
    if(!/^song-[a-f0-9-]{36}$/.test(id??'')||!/^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(bvid??''))throw Error('SINGING_MP3_ID_INVALID');
    const source=regular(master?.path);
    if(fileSha(source)!==master.sha256||!Number.isSafeInteger(master.frames)||master.frames<=0)throw Error('SINGING_MASTER_CHANGED');
    const folder=path.join(directory,id);fs.mkdirSync(folder,{recursive:false});
    regular(source);
    for(let p=folder;;p=path.dirname(p)){if(fs.lstatSync(p).isSymbolicLink())throw Error('SINGING_LINK_REJECTED');if(path.dirname(p)===p)break;}
    const file=path.join(folder,'cover.mp3'),options={windowsHide:true,signal,timeout:90000,maxBuffer:65536};
    await exec(ffmpeg,['-v','error','-nostdin','-threads','2','-i',source,'-map','0:a:0','-map_metadata','-1','-c:a','libmp3lame','-b:a','320k','-ar','44100','-ac','2',file],options);
    const {stdout}=await exec(ffprobe,['-v','error','-select_streams','a:0','-show_entries','stream=codec_name,sample_rate,channels,bit_rate:format=duration','-of','json',file],options);
    const info=JSON.parse(stdout),stream=info.streams?.[0];
    await exec(ffmpeg,['-v','error','-nostdin','-xerror','-i',file,'-f','null','-'],options);
    signal?.throwIfAborted();
    if(fileSha(source)!==master.sha256)throw Error('SINGING_MASTER_CHANGED');
    const manifest=path.join(folder,'mp3.json');
    const name=(String(title??bvid).replace(/[\\/:*?"<>|\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/\s+/g,' ').trim().slice(0,100)||bvid)+' - 小鲸鱼翻唱.mp3';
    atomic(manifest,{schema:'singing-mp3-v1',file,name,sourceSha256:master.sha256,sourceFrames:master.frames,codec:stream?.codec_name,sampleRate:Number(stream?.sample_rate),channels:stream?.channels,bitRate:Number(stream?.bit_rate),durationSeconds:Number(info.format?.duration),fullDecode:true,bytes:fs.statSync(file).size,sha256:fileSha(file),md5:md5(file),createdAt:Date.now()});
    checkedMp3(manifest);return manifest;
  };
}
