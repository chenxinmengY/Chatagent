import {mediaDay} from '../media-experiences/ledger.mjs';
import fs from 'node:fs';import path from 'node:path';import {sha} from './contracts.mjs';import {randomUUID} from 'node:crypto';
export function createJournal(directory,{maxCalls=12,daily=false}={}){
 directory=path.resolve(directory);fs.mkdirSync(directory,{recursive:true});
 const file=key=>path.join(directory,sha(key)+'.json');
 return {
  read(key){const p=file(key);return fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):null;},
  reserve(key,data){
   if(data.origin!=='invited'&&fs.readdirSync(directory).filter(f=>/^[a-f0-9]{64}\.json$/.test(f)).filter(f=>{const old=JSON.parse(fs.readFileSync(path.join(directory,f),'utf8'));return old.origin!=='invited'&&(!daily||mediaDay(old.at)===mediaDay(data.at));}).length>=maxCalls)throw Error('MUSIC_BATCH_BUDGET');
   const fd=fs.openSync(file(key),'wx');try{fs.writeFileSync(fd,JSON.stringify({...data,phase:'reserved_before_submission',status:'unconfirmed',mayHaveBeenSubmitted:true},null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  },
  finish(key,data){const p=file(key),temporary=p+'.'+randomUUID()+'.tmp';try{const fd=fs.openSync(temporary,'wx');try{fs.writeFileSync(fd,JSON.stringify({...data,phase:'returned'},null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,p);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}},
  files:()=>fs.readdirSync(directory).filter(f=>f.endsWith('.json')).map(f=>path.join(directory,f)),
  entries:()=>fs.readdirSync(directory).filter(f=>/^[a-f0-9]{64}\.json$/.test(f)).map(f=>JSON.parse(fs.readFileSync(path.join(directory,f),'utf8'))),
 };
}
