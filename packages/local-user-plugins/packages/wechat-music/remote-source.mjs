import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {randomUUID} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {isolatedDirectory} from './isolation.mjs';import {sha} from './contracts.mjs';import {inspectPcm} from './pcm.mjs';
const exec=promisify(execFile),base=fileURLToPath(new URL('.',import.meta.url)),workspace=path.dirname(base),BV=/^BV[1-9A-HJ-NP-Za-km-z]{10}$/,HASH=/^[a-f0-9]{64}$/;
const MAX_SOURCE=24*1024*1024,MAX_FLAC=8*1024*1024,MAX_TASKS=2,MAX_SOURCES=128;
const descriptor=r=>Object.freeze({bvid:r.bvid,cid:r.cid,sourceSha256:r.sourceSha256,wholeSha256:r.wholeSha256,seconds:r.seconds});
const same=(a,b)=>a&&b&&Object.keys(a).length===5&&['bvid','cid','sourceSha256','wholeSha256','seconds'].every(k=>a[k]===b[k]);
function valid(r){return r&&BV.test(r.bvid)&&Number.isSafeInteger(r.cid)&&r.cid>0&&HASH.test(r.sourceSha256)&&HASH.test(r.wholeSha256)&&HASH.test(r.pcmSha256)&&r.seconds>0&&r.seconds<=300&&r.bytes>0&&r.bytes<=MAX_FLAC&&r.sourceBytes>0&&r.sourceBytes<=MAX_SOURCE&&r.completeEof===true;}
export async function runSourceProcess(executable,args,options){
 const running=exec(executable,args,options),closed=new Promise(resolve=>running.child.once('close',resolve));
 try{return await running;}finally{await closed;}
}
async function fetchTrack({bvid,directory,signal,python}){
 signal?.throwIfAborted();try{
  const {stdout}=await runSourceProcess(python,[path.join(base,'source-download.py'),bvid,directory],{windowsHide:true,encoding:'utf8',timeout:100000,maxBuffer:16384,signal});
  const result=JSON.parse(stdout.trim());if(result.error)throw Error(result.error);return result;
 }catch(e){let code;try{code=JSON.parse(e.stdout?.trim()??'{}').error;}catch{}throw Error(signal?.aborted?'MUSIC_CANCELLED':/^MUSIC_[A-Z0-9_]{1,80}$/.test(code??e.message??'')?(code??e.message):'MUSIC_SOURCE_FETCH_FAILED');}
}
async function ff(args,{input,signal}={}){
 signal?.throwIfAborted();const child=exec('ffmpeg',['-v','error','-nostdin','-threads','2',...args],{windowsHide:true,encoding:'buffer',timeout:20000,maxBuffer:12*1024*1024,signal});
 if(input)child.child.stdin.end(input);try{return (await child).stdout;}catch{throw Error(signal?.aborted?'MUSIC_CANCELLED':'MUSIC_AUDIO_PREPARATION_FAILED');}
}
export function createRemoteSource({directory,python,download=options=>fetchTrack({...options,python})}={}){
 directory=isolatedDirectory(directory);if(!path.relative(path.join(base,'state'),directory)||!directory.startsWith(path.join(base,'state')+path.sep))throw Error('MUSIC_ISOLATED_DIRECTORY_REQUIRED');
 fs.mkdirSync(directory,{recursive:true});const media=path.join(directory,'media'),metadata=path.join(directory,'metadata');
 for(const p of [media,metadata]){isolatedDirectory(p);fs.mkdirSync(p,{recursive:true});}
 const entries=new Map(),pending=new Map(),tasks=new Map();let closed=false,acquisitions=0;
 for(const name of fs.readdirSync(metadata)){if(!/^BV[1-9A-HJ-NP-Za-km-z]{10}\.json$/.test(name))throw Error('MUSIC_SOURCE_METADATA_INVALID');const file=path.join(metadata,name);isolatedDirectory(file);const r=JSON.parse(fs.readFileSync(file,'utf8'));if(!valid(r)||name!==r.bvid+'.json')throw Error('MUSIC_SOURCE_METADATA_INVALID');entries.set(r.bvid,{record:r});}
 if(entries.size>MAX_SOURCES)throw Error('MUSIC_SOURCE_METADATA_LIMIT');
 const check=()=>{if(closed)throw Error('MUSIC_SOURCE_CLOSED');};
 const verify=source=>{const entry=entries.get(source?.bvid);if(!entry||!same(source,descriptor(entry.record)))throw Error('MUSIC_SOURCE_CHANGED');return entry;};
 function remove(task){
  if(!tasks.has(task.name))throw Error('MUSIC_TASK_OWNER_REQUIRED');const target=isolatedDirectory(path.join(media,task.name));
  if(path.dirname(target)!==media||!/^task-[0-9a-f-]{36}$/.test(task.name))throw Error('MUSIC_TASK_OWNER_REQUIRED');
  const ownerPath=isolatedDirectory(path.join(target,'owner.json'));const owner=JSON.parse(fs.readFileSync(ownerPath,'utf8'));
  if(owner.schema!=='music-remote-task-v1'||owner.owner!==task.owner||owner.task!==task.name)throw Error('MUSIC_TASK_OWNER_REQUIRED');
  const names=fs.readdirSync(target);if(names.some(name=>!['owner.json','source.m4a','whole.flac'].includes(name)))throw Error('MUSIC_TASK_UNKNOWN_FILE');
  // Validate every absolute target before deleting any file. Never recurse.
  const files=names.filter(name=>name!=='owner.json').concat('owner.json').map(name=>isolatedDirectory(path.join(target,name)));for(const file of files)if(!fs.lstatSync(file).isFile())throw Error('MUSIC_TASK_UNKNOWN_FILE');
  for(const file of files)fs.unlinkSync(file);fs.rmdirSync(target);tasks.delete(task.name);
 }
 function allocate(){
  isolatedDirectory(media);const old=fs.readdirSync(media);if(old.length>=MAX_TASKS)throw Error('MUSIC_TEMP_CACHE_LIMIT');
  // Old crash leftovers count against the fixed task cap. They are never
  // adopted or deleted by a new provider instance.
  for(const name of old)if(!tasks.has(name))throw Error('MUSIC_TEMP_RECOVERY_REQUIRED');
  const name='task-'+randomUUID(),task={name,owner:randomUUID()};const target=isolatedDirectory(path.join(media,name));fs.mkdirSync(target);
  fs.writeFileSync(path.join(target,'owner.json'),JSON.stringify({schema:'music-remote-task-v1',task:name,owner:task.owner}),{flag:'wx'});tasks.set(name,task);return {task,target};
 }
 async function acquire(bvid,{signal,expected}={}){
  check();signal?.throwIfAborted();if(pending.has(bvid))return pending.get(bvid);const entry=entries.get(bvid);
  if(entry?.task)return entry;const work=(async()=>{
   const {task,target}=allocate();try{
    const r=await download({bvid,directory:target,signal});signal?.throwIfAborted();check();
    if(!valid(r)||r.bvid!==bvid)throw Error('MUSIC_SOURCE_METADATA_INVALID');
    const original=isolatedDirectory(path.join(target,'source.m4a')),whole=isolatedDirectory(path.join(target,'whole.flac'));
    if(fs.statSync(original).size!==r.sourceBytes||fs.statSync(whole).size!==r.bytes||sha(fs.readFileSync(original))!==r.sourceSha256||sha(fs.readFileSync(whole))!==r.wholeSha256)throw Error('MUSIC_SOURCE_BINDING');
    if(expected&&(!same(descriptor(r),descriptor(expected))||r.pcmSha256!==expected.pcmSha256))throw Error('MUSIC_RECORDING_CHANGED');
    const saved={...descriptor(r),pcmSha256:r.pcmSha256,bytes:r.bytes,sourceBytes:r.sourceBytes,completeEof:true,title:typeof r.title==='string'?r.title.slice(0,256):'',downloadAndPreparationMs:r.downloadAndPreparationMs??0};
    if(!entry){if(entries.size>=MAX_SOURCES)throw Error('MUSIC_SOURCE_METADATA_LIMIT');fs.writeFileSync(path.join(metadata,bvid+'.json'),JSON.stringify(saved,null,2),{flag:'wx'});}
    const next=entry??{record:saved};next.task=task;entries.set(bvid,next);acquisitions++;return next;
   }catch(e){remove(task);throw e;}
  })();pending.set(bvid,work);try{return await work;}finally{pending.delete(bvid);}
 }
 return {
  async resolve(bvid,{signal}={}){check();signal?.throwIfAborted();if(!BV.test(bvid??''))throw Error('MUSIC_SOURCE_ID_INVALID');const entry=entries.get(bvid)??await acquire(bvid,{signal});return descriptor(entry.record);},
  metadata(source){check();const entry=verify(source),pageTitle=typeof entry.record.title==='string'?entry.record.title.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,256):'';return {status:pageTitle?'available':'unavailable',pageTitle:pageTitle||null,provenance:'bilibili_page_metadata',independentSongIdentification:false,untrusted:true};},
  references(source){verify(source);return [];},reference(source){verify(source);return null;},
  async prepare(source,{start=0,end=source.seconds,signal}={}){
   const began=performance.now();check();const entry=verify(source);signal?.throwIfAborted();
   if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>source.seconds||end<=start)throw Error('MUSIC_RANGE_INVALID');
   const a=Math.round(start*16000),b=Math.round(end*16000),complete=a===0&&b===Math.round(source.seconds*16000);if(!complete&&b-a>30*16000)throw Error('MUSIC_CLIP_TOO_LONG');
   const current=await acquire(source.bvid,{signal,expected:entry.record}),target=isolatedDirectory(path.join(media,current.task.name)),data=fs.readFileSync(isolatedDirectory(path.join(target,'whole.flac')));
   if(sha(data)!==source.wholeSha256)throw Error('MUSIC_SOURCE_CHANGED');
   const pcm=await ff(['-i','pipe:0','-f','s16le','-ar','16000','-ac','1','pipe:1'],{input:data,signal});const details=inspectPcm(pcm);
   if(details.pcmSha256!==entry.record.pcmSha256||details.seconds!==source.seconds)throw Error('MUSIC_PCM_BINDING');
   const selected=pcm.subarray(a*2,b*2),clip=inspectPcm(selected);if(clip.constantSignal)return {status:'no_acoustic_signal',...clip,start:a/16000,end:b/16000,completeTrack:complete,preparationMs:Math.round(performance.now()-began)};
   const encoded=complete?data:await ff(['-f','s16le','-ar','16000','-ac','1','-i','pipe:0','-map_metadata','-1','-c:a','flac','-compression_level','5','-f','flac','pipe:1'],{input:selected,signal});
   if(encoded.length>MAX_FLAC)throw Error('MUSIC_AUDIO_SIZE');
   if(!complete){const decoded=await ff(['-i','pipe:0','-f','s16le','-acodec','pcm_s16le','pipe:1'],{input:encoded,signal});if(!decoded.equals(selected))throw Error('MUSIC_CLIP_BINDING');}
   signal?.throwIfAborted();return {status:'ready',data:encoded,sha256:sha(encoded),pcmSha256:clip.pcmSha256,seconds:clip.seconds,mime:'audio/flac',start:a/16000,end:b/16000,completeTrack:complete,preparationMs:Math.round(performance.now()-began)};
  },
  async release(source){const entry=verify(source);await pending.get(source.bvid)?.catch(()=>{});if(entry.task){remove(entry.task);delete entry.task;}},
  async close(){closed=true;await Promise.allSettled([...pending.values()]);for(const entry of entries.values())if(entry.task){remove(entry.task);delete entry.task;}},
  snapshot(){let mediaBytes=0;const count=directory=>{for(const name of fs.readdirSync(directory)){const target=isolatedDirectory(path.join(directory,name)),stat=fs.lstatSync(target);if(stat.isDirectory())count(target);else if(stat.isFile())mediaBytes+=stat.size;else throw Error('MUSIC_TASK_UNKNOWN_FILE');}};count(media);return {acquisitions,activeTasks:tasks.size,mediaBytes,metadataRecords:entries.size};},
 };
}
