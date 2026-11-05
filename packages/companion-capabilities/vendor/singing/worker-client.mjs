import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import {recordOwnerExit} from './owner-exit.mjs';
export function createWorkerClient({python,entry,launcherPython,ownershipModule,directory,onState=()=>{},shutdownGraceMs=10000,runTimeoutMs=330000}) {
  if(!launcherPython||!ownershipModule)throw Error('SINGING_OWNER_CONFIG_REQUIRED');
  if(!Number.isSafeInteger(shutdownGraceMs)||shutdownGraceMs<1||!Number.isSafeInteger(runTimeoutMs)||runTimeoutMs<1)throw Error('SINGING_OWNER_TIMEOUT_INVALID');
  fs.mkdirSync(directory,{recursive:true});
  const ownershipReport=path.join(directory,'owner-'+randomUUID()+'.json');
  const errorLog=fs.openSync(directory+'/worker-stderr.log','a');
  let child;
  try{child=spawn(launcherPython,['-X','utf8','-u','-B',path.join(import.meta.dirname,'owned-worker-launch.py'),'--worker-python',python,'--entry',entry,'--ownership-module',ownershipModule,'--report',ownershipReport],{windowsHide:true,stdio:['pipe','pipe',errorLog],env:{...process.env,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'}});}
  finally{fs.closeSync(errorLog);}
  let ready=false,closed=false,exited=false,closing=false,active=null,closePromise=null,workerState='preparing',runtimeDirectory=null;
  const state=value=>{workerState=value;onState(value);};
  const send=value=>{if(closed||exited||!child.stdin.writable)throw Error('SINGING_WORKER_UNAVAILABLE');child.stdin.write(JSON.stringify(value)+'\n');};
  const ended=new Promise(resolve=>child.once('close',(code,signal)=>{closed=true;ready=false;resolve({code,signal});}));
  // Killing this actual base-Python owner closes its retained non-inheritable
  // Job handle. Wait for 'close', including inherited worker pipe closure.
  const killOwner=()=>{if(!closed&&!exited)child.kill();};
  const lineReader=readline.createInterface({input:child.stdout});
  const fail=code=>{ready=false;active?.reject(Error(code));active=null;state('unavailable');};
  lineReader.on('line',line=>{
    let event;try{event=JSON.parse(line);}catch{return;}
    if(event.type==='ready'){
      if(workerState==='unavailable'||closing)return;
      let proof;try{proof=JSON.parse(fs.readFileSync(ownershipReport,'utf8'));}catch{}
      if(proof?.schema!=='singing-owned-launch-v1'||proof.ownerPid!==child.pid||proof.killOnOwnerExit!==true){fail('SINGING_OWNER_IDENTITY_MISMATCH');killOwner();return;}
      if(typeof event.directory==='string'&&path.isAbsolute(event.directory)&&path.resolve(path.dirname(path.dirname(event.directory))).toLowerCase()===path.resolve(path.dirname(entry)).toLowerCase()&&/^[a-f0-9]{32}$/.test(path.basename(event.directory)))runtimeDirectory=event.directory;
      ready=event.primed===true;state(ready?'ready':'preparing');return;
    }
    if(event.type==='preparing'){if(workerState!=='unavailable'&&!closing){ready=false;state('preparing');}return;}
    if(event.type==='fatal'){fail('SINGING_WORKER_FATAL');return;}
    if(!active||event.id!==active.id)return;
    if(event.type==='accepted'){active.onArtifacts?.(event.manifestPath);return;}
    if(event.type==='progress'){active.onProgress?.(event.stage);return;}
    if(event.type==='done'){const item=active;active=null;item.resolve(event);}
    else if(['error','cancelled','rejected'].includes(event.type)){const item=active;active=null;item.reject(Error(event.type==='cancelled'?'SINGING_CANCELLED':'SINGING_WORKER_FAILED'));}
  });
  child.stdin.on('error',()=>{ready=false;});
  child.on('error',()=>fail('SINGING_WORKER_UNAVAILABLE'));
  child.on('exit',()=>{exited=true;ready=false;state('unavailable');});
  child.on('close',()=>{recordOwnerExit(ownershipReport,child.pid);fail('SINGING_WORKER_EXITED');lineReader.close();});
  return {
    get ready(){return ready&&!closed&&!exited&&!closing;},get state(){return closed||exited||closing?'unavailable':workerState;},get pid(){return child.pid;},get ownershipReport(){return ownershipReport;},get runtimeDirectory(){return runtimeDirectory;},
    run({id,inputPath,inputSha256,mode='clip',signal,onProgress,onArtifacts}) {
      signal?.throwIfAborted();
      if(!ready||active||closed||exited||closing)return Promise.reject(Error('SINGING_WORKER_NOT_READY'));
      return new Promise((resolve,reject)=>{
        let grace;
        const abort=()=>{try{send({command:'cancel',id});}catch{}if(!grace)grace=setTimeout(killOwner,shutdownGraceMs);};
        const clear=callback=>value=>{clearTimeout(timer);clearTimeout(grace);signal?.removeEventListener('abort',abort);callback(value);};
        const timer=setTimeout(()=>{abort();},runTimeoutMs);
        active={id,onProgress,onArtifacts,resolve:clear(resolve),reject:clear(reject)};
        ready=false;workerState='preparing';
        signal?.addEventListener('abort',abort,{once:true});
        try{send({command:'run',id,inputPath,inputSha256,mode});}catch(error){active=null;clear(reject)(error);}
      });
    },
    cancel(id){if(active?.id===id)send({command:'cancel',id});},
    close(){
      if(closePromise)return closePromise;
      closing=true;ready=false;
      closePromise=(async()=>{
        if(closed)return;
        try{send({command:'shutdown',id:'bridge-close'});}catch{}
        const timer=setTimeout(killOwner,shutdownGraceMs);
        try{await ended;}finally{clearTimeout(timer);lineReader.close();}
      })();
      return closePromise;
    },
  };
}
