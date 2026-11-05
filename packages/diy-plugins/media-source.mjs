import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createIsolatedAsrProvider} from '../companion-capabilities/isolated-asr.mjs';
const exec=promisify(execFile),script=fileURLToPath(new URL('./bili-media.py',import.meta.url));
export function videoId(input){
 if(!input)return null;if(/^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(input))return input;
 let url;try{url=new URL(input);}catch{throw Error('PLUGIN_VIDEO_URL_INVALID');}
 if(url.protocol!=='https:'||!['www.bilibili.com','bilibili.com','m.bilibili.com'].includes(url.hostname)||url.username||url.password||url.port)throw Error('PLUGIN_VIDEO_URL_INVALID');
 const id=/^\/video\/(BV[1-9A-HJ-NP-Za-km-z]{10})\/?$/.exec(url.pathname)?.[1];if(!id)throw Error('PLUGIN_VIDEO_URL_INVALID');return id;
}
export function allowedMediaUrl(raw){
 const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||!['','8082'].includes(u.port)||!['bilivideo.com','bilivideo.cn','bilivideo.net','hdslb.com'].some(d=>u.hostname===d||u.hostname.endsWith('.'+d)))throw Error('PLUGIN_MEDIA_ORIGIN_INVALID');return u;
}
async function download(raw,file,limit,signal){
 signal=AbortSignal.any([signal,AbortSignal.timeout(60000)]);
 const url=allowedMediaUrl(raw),response=await fetch(url,{signal,redirect:'error',headers:{Referer:'https://www.bilibili.com/','User-Agent':'Mozilla/5.0'}});
 if(!response.ok||Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw Error('PLUGIN_MEDIA_DOWNLOAD_FAILED');}
 const fd=fs.openSync(file,'wx');let size=0;try{for await(const chunk of response.body){signal.throwIfAborted();size+=chunk.length;if(size>limit)throw Error('PLUGIN_MEDIA_TOO_LARGE');fs.writeSync(fd,chunk);}}finally{fs.closeSync(fd);}
}
export function createMediaSource({root,python,asrRoot}){
 if(!python||!asrRoot||!fs.existsSync(python)||!fs.existsSync(path.join(asrRoot,'ffmpeg.exe')))return null;
 const recognize=createIsolatedAsrProvider({root:asrRoot});
 async function metadata(action,value,signal){
  let stdout;try{({stdout}=await exec(python,['-B','-s',script,action,value],{signal,windowsHide:true,timeout:35000,maxBuffer:512*1024,env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'}}));}catch{throw Error('PLUGIN_BILI_SOURCE_FAILED');}
  const result=JSON.parse(stdout);if(result.error)throw Error(result.error);return result;
 }
 return async({input,signal,jobId,select})=>{
  const id=videoId(input)||await select((await metadata('hot','1',signal)).candidates);
  const info=await metadata('media',id,signal);if(info.bvid!==id||!Number.isFinite(info.duration)||info.duration<=0||info.duration>600)throw Error('PLUGIN_MEDIA_INVALID');
  const folder=path.resolve(root,jobId);if(!/^[\w-]{1,150}$/.test(jobId)||path.dirname(folder)!==path.resolve(root))throw Error('PLUGIN_MEDIA_PATH_INVALID');
  fs.mkdirSync(folder,{recursive:true});const video=path.join(folder,'video.mp4'),audio=path.join(folder,'audio.m4a');
  try{
   await download(info.videoUrl,video,80*1024*1024,signal);
   if(info.audioUrl!==info.videoUrl)await download(info.audioUrl,audio,20*1024*1024,signal);
   const images=[],interval=Math.max(1,info.duration/12);
   await exec(path.join(asrRoot,'ffmpeg.exe'),['-nostdin','-v','error','-i',video,'-vf',`fps=1/${interval},scale=640:-2`,'-frames:v','12','-q:v','5','-n',path.join(folder,'frame-%02d.jpg')],{signal,windowsHide:true,timeout:45000,maxBuffer:65536});
   for(const name of fs.readdirSync(folder).filter(n=>/^frame-\d{2}\.jpg$/.test(n)).sort())images.push(fs.readFileSync(path.join(folder,name)));
   if(!images.length)throw Error('PLUGIN_FRAMES_UNAVAILABLE');
   const transcript=[];let audioSeconds=0;
   for(let offset=0;offset<info.duration;offset+=120){const dir=path.join(folder,'asr-'+offset);fs.mkdirSync(dir);const seconds=Math.min(120,info.duration-offset);const result=await recognize({file:info.audioUrl===info.videoUrl?video:audio,directory:dir,signal,offsetSeconds:offset,segmentSeconds:seconds});transcript.push(result.text);audioSeconds+=seconds;}
   return {bvid:id,title:info.title,images,subtitles:[],transcript:transcript.join('\n').slice(0,18000),evidence:{kind:'sampled-frames-and-asr',frameCount:images.length,duration:info.duration,audioSeconds,originalAudioToModel:false,asr:'SenseVoice 语音转写',limitations:'抽帧画面与语音文字；没有分析音乐、声线或环境声音。'}};
  }finally{
   // Only this validated task directory, never a plugin-supplied arbitrary path.
   if(fs.existsSync(folder)&&path.dirname(folder)===path.resolve(root))fs.rmSync(folder,{recursive:true,force:true});
  }
 };
}
