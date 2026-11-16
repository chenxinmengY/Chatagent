import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {fileSha,read} from './vendor/singing/common.mjs';
import {verifyAudio} from './media.mjs';
import {importSingingResult} from './isolated-singing.mjs';

const execute=promisify(execFile);
const script=fileURLToPath(new URL('./rvc-voice.py',import.meta.url));
const owner=fileURLToPath(new URL('./vendor/singing/owned-worker-launch.py',import.meta.url));

async function run(profileFile,folder,args,signal){
  const profile=read(profileFile), report=path.join(folder,'rvc-owner-'+randomUUID()+'.json');
  const running=execute(profile.launcherPython,['-X','utf8',owner,'--worker-python',profile.python,'--entry',script,
    '--ownership-module',profile.ownershipModule??path.dirname(owner),'--report',report,'--args-json',JSON.stringify([profileFile,...args])],
    {windowsHide:true,signal,timeout:1200000,maxBuffer:4*1024*1024,env:{...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'}});
  const ended=new Promise(resolve=>running.child.once('close',resolve));
  try{
    await running;
    const status=read(report);
    if(status.ownerPid!==running.child.pid||status.state!=='closed'||status.workerExitCode!==0||status.cleanup?.after?.active_processes!==0)throw Error('RVC_OWNER_FAILED');
  } catch(error) {
    if(error.stderr)fs.writeFileSync(path.join(folder,'rvc-error.log'),[error.stdout?.slice(-8000),error.stderr.slice(-8000)].join('\n'));
    throw error;
  } finally{await ended;}
}

export function rvcSpeechProvider(tts,profileFile){
  return {async synthesize(request){
    if(!/^[\w-]{1,100}$/.test(request.id))throw Error('VOICE_REPLY_REQUEST_INVALID');
    const temp=fs.mkdtempSync(path.join(request.directory,'rvc-'));
    const target=path.join(request.directory,request.id+'.wav');
    try{
      const source=await tts.synthesize({...request,directory:temp,id:'source'});
      const converted=path.join(temp,'voice.wav');
      await run(profileFile,temp,['speech',source.file,converted],request.signal);
      const checked=await verifyAudio(converted,{maxSeconds:600,signal:request.signal});
      request.signal?.throwIfAborted();
      fs.copyFileSync(converted,target,fs.constants.COPYFILE_EXCL);
      return {...checked,file:target,provenance:'local-cosyvoice3-mansui-rvc'};
    }finally{fs.rmSync(temp,{recursive:true,force:true});}
  }};
}

export async function runRvcSong(profileFile,outputRoot,args){
  const runtime=path.join(read(profileFile).root,'runs',randomUUID());
  const job=path.join(runtime,'jobs',args.id);
  fs.mkdirSync(job,{recursive:true});
  args.onProgress?.('worker');
  await run(profileFile,job,[args.mode,args.inputPath,job,args.inputSha256],args.signal);
  args.signal?.throwIfAborted();
  const manifest=path.join(job,'result.json');
  const result=read(manifest);
  args.onArtifacts?.(manifest);
  if(args.mode==='clip'){
    result.segmentsManifest=path.join(job,'segments','segments.json');
    result.segmentsManifestSha256=fileSha(result.segmentsManifest);
  }
  return importSingingResult({runtimeDirectory:runtime,outputRoot,id:args.id,mode:args.mode,result});
}
