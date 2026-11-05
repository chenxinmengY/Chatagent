import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {atomic,read,regular,fileSha} from './common.mjs';
import {recordOwnerExit} from './owner-exit.mjs';
const exec=promisify(execFile);
async function run(file,args,{signal,timeout=25000,ownerReport,...options}={}) {
  signal?.throwIfAborted();
  const running=exec(file,args,{windowsHide:true,encoding:'utf8',maxBuffer:32768,timeout,signal,...options});
  const closed=new Promise(resolve=>running.child.once('close',resolve));
  try{
    const result=await running;
    if(ownerReport){
      const proof=read(ownerReport);
      if(proof.schema!=='singing-owned-launch-v1'||proof.ownerPid!==running.child.pid||proof.state!=='closed'||proof.workerExitCode!==0||proof.cleanup?.after?.active_processes!==0)throw Error('SINGING_SOURCE_OWNER_INVALID');
    }
    return result;
  }finally{await closed;if(ownerReport)recordOwnerExit(ownerReport,running.child.pid);}
}
export function createSingingSource({directory,inputsDirectory,python,launcherPython,ownershipModule,downloader,downloaderSha256,ownedProcessDir,seeds=[]}) {
  if(!launcherPython||!ownershipModule)throw Error('SINGING_OWNER_CONFIG_REQUIRED');
  fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(inputsDirectory,{recursive:true});
  const indexFile=path.join(directory,'index.json');
  const index=fs.existsSync(indexFile)?read(indexFile):{};
  for(const entry of seeds) if(!index[entry.identity.bvid])index[entry.identity.bvid]=entry;
  atomic(indexFile,index);
  const verify=entry=>{
    if(!entry?.completeEof||!/^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(entry.identity?.bvid??'')||!Number.isSafeInteger(entry.identity.cid)||entry.identity.cid<=0||!/^[a-f0-9]{64}$/.test(entry.identity.sourceSha256??'')||!Number.isSafeInteger(entry.frames)||entry.frames<=0||entry.frames>300*44100||fileSha(entry.path)!==entry.sha256)throw Error('SINGING_SOURCE_CHANGED');
    return structuredClone(entry);
  };
  return {
    peek(bvid){if(!index[bvid])return null;try{return verify(index[bvid]);}catch{delete index[bvid];atomic(indexFile,index);return null;}},
    async resolve(request,{signal,onOwned}={}) {
      signal?.throwIfAborted();
      if(!/^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(request.bvid??''))throw Error('SINGING_SOURCE_ID_INVALID');
      if(index[request.bvid]){try{return verify(index[request.bvid]);}catch{delete index[request.bvid];atomic(indexFile,index);}}
      const id='task-'+randomUUID(),folder=path.join(directory,id);
      fs.mkdirSync(folder);atomic(path.join(folder,'owner.json'),{schema:'singing-source-v1',id});
      onOwned?.(folder);
      const ownerReport=path.join(folder,'process-owner.json');
      const scriptArgs=['--bvid',request.bvid,'--directory',folder,'--downloader',downloader,'--downloader-sha256',downloaderSha256,'--owned-process-dir',ownedProcessDir];
      const {stdout}=await run(launcherPython,['-X','utf8','-u','-B',path.join(import.meta.dirname,'owned-worker-launch.py'),'--worker-python',python,'--entry',path.join(import.meta.dirname,'source_download.py'),'--ownership-module',ownershipModule,'--report',ownerReport,'--args-json',JSON.stringify(scriptArgs)],{signal,timeout:100000,ownerReport});
      signal?.throwIfAborted();
      let record;try{record=JSON.parse(stdout.trim());}catch{throw Error('SINGING_SOURCE_FETCH_FAILED');}
      if(record.error)throw Error(record.error);
      if(record.identity?.bvid!==request.bvid||path.dirname(record.path)!==folder)throw Error('SINGING_SOURCE_BINDING');
      verify(record);index[request.bvid]=record;atomic(indexFile,index);return record;
    },
    async prepare(recording,request,{id,signal}={}) {
      verify(recording);signal?.throwIfAborted();
      if(request.mode==='whole')return {path:recording.path,sha256:recording.sha256};
      const start=Math.round(request.start*44100),end=Math.round(request.end*44100);
      if(!Number.isSafeInteger(start)||start<0||end>recording.frames||end<=start||end-start>300*44100)throw Error('SINGING_CLIP_RANGE');
      if(!/^song-[a-f0-9-]{36}$/.test(id??''))throw Error('SINGING_JOB_ID');
      const output=path.join(inputsDirectory,id+'.wav');
      await run('ffmpeg',['-v','error','-nostdin','-threads','2','-i',recording.path,'-af',`atrim=start_sample=${start}:end_sample=${end},asetpts=PTS-STARTPTS`,'-ar','44100','-ac','2','-map_metadata','-1','-c:a','pcm_s24le',output],{signal});
      signal?.throwIfAborted();return {path:regular(output),sha256:fileSha(output)};
    },
  };
}
