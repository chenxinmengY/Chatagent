import {sha} from './contracts.mjs';
export function inspectPcm(pcm){
 if(!Buffer.isBuffer(pcm)||!pcm.length||pcm.length%2||pcm.length>300*32000)throw Error('MUSIC_PCM_FORMAT');
 const first=pcm.readInt16LE(0);let constant=true;for(let i=2;i<pcm.length;i+=2)if(pcm.readInt16LE(i)!==first){constant=false;break;}
 return {seconds:pcm.length/32000,pcmSha256:sha(pcm),constantSignal:constant};
}