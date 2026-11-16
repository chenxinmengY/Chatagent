import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
// Convert only verified bytes; stdin/stdout keep private audio out of shared files.
export async function musicAudio(audio,protocol,{signal,ffmpeg='ffmpeg'}={}){
 if(protocol!=='chat-completions'||audio.mime!=='audio/flac')return audio;
 const data=await new Promise((resolve,reject)=>{
  const child=execFile(ffmpeg,['-nostdin','-v','error','-xerror','-i','pipe:0','-vn','-ac','1','-ar','16000','-c:a','pcm_s16le','-f','wav','pipe:1'],{windowsHide:true,encoding:'buffer',maxBuffer:12*1024*1024,timeout:30000,signal},(error,out)=>error?reject(Error('MEDIA_AUDIO_CONVERSION_FAILED')):resolve(out));child.stdin.on('error',()=>{});child.stdin.end(audio.data);
 });
 if(data.toString('ascii',0,4)!=='RIFF'||data.toString('ascii',8,12)!=='WAVE')throw Error('MEDIA_AUDIO_CONVERSION_FAILED');
 let pcm;for(let offset=12;offset+8<=data.length;){let size=data.readUInt32LE(offset+4);if(data.toString('ascii',offset,offset+4)==='data'){size=data.length-offset-8;data.writeUInt32LE(size,offset+4);pcm=data.subarray(offset+8);break;}offset+=8+size+(size%2);}
 if(!pcm?.length||Math.abs(pcm.length/32000-audio.seconds)>1/16000)throw Error('MEDIA_AUDIO_CONVERSION_FAILED');data.writeUInt32LE(data.length-8,4);
 return {...audio,data,mime:'audio/wav',sha256:createHash('sha256').update(data).digest('hex')};
}
