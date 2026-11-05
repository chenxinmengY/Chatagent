import fs from 'node:fs';
import path from 'node:path';
import { hash } from '../migration/portable.mjs';
import { fault } from '../conversation/store.mjs';
export function fishAdmin(memory, memoryId, root) {
  const file=path.join(root,'state/chatagent-memory-settings.json');
  const settings=()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{enabled:true};
  const read=()=>{const data=memory.loadStore(memoryId), config=settings();return {engine:'dsh-fish-memory',revision:hash([data,config]),enabled:config.enabled,policy:data.policy,memories:data.memories,deleted:data.deleted,traces:data.traces};};
  return {read,enabled:()=>settings().enabled,migrate(value){
    const old=read(),records=value.records;
    if(!Array.isArray(records)||!records.length||records.length>50000)throw fault('MEMORY_IMPORT_INVALID',400);
    if(new Set(records.map(r=>JSON.stringify([r.sourceId,r.scope]))).size!==1)throw fault('MEMORY_SELECT_ONE_SOURCE',400);
    const data=memory.loadStore(memoryId),seen=new Map([...data.memories.map(n=>({state:'active',n})),...data.deleted.map(n=>({state:'deleted',n}))].map(r=>[String(r.n.id),r]));
    let added=0,duplicates=0,conflicts=0;const incoming=[];
    for(const r of records){
      const n=r.metadata?.native,state=r.metadata?.state;
      if(r.kind!=='memory'||r.metadata?.engine!=='dsh-fish-memory'||r.metadata?.engineVersion!=='1.5.0'||!['active','deleted'].includes(state)||!n||typeof n.id!=='string'||!n.id||typeof n.text!=='string'||n.text!==r.text||!Number.isFinite(n.importance)||!Number.isFinite(Date.parse(n.at))||!Array.isArray(n.tags))throw fault('MEMORY_IMPORT_UNSUPPORTED',400);
      const previous=seen.get(n.id);
      if(previous){if(previous.state===state&&hash(previous.n)===hash(n))duplicates++;else conflicts++;}
      else{seen.set(n.id,{state,n});incoming.push({state,n});added++;}
    }
    const report={added,duplicates,conflicts,revision:old.revision},preview=hash([report,records]);
    if(!value.apply)return {...report,preview};
    if(value.preview!==preview||value.revision!==old.revision)throw fault('MEMORY_CHANGED');
    if(conflicts)throw fault('IMPORT_CONFLICT');
    for(const {state,n} of incoming)data[state==='active'?'memories':'deleted'].push(structuredClone(n));
    memory.saveStore(memoryId,data);
    const saved=memory.loadStore(memoryId);
    if(incoming.some(({state,n})=>!saved[state==='active'?'memories':'deleted'].some(r=>String(r.id)===n.id&&r.text===n.text)))throw fault('MEMORY_SAVE_FAILED');
    return {...report,revision:read().revision};
  },save(value){
    const old=read();if(value.revision!==old.revision)throw fault('MEMORY_CHANGED');
    if(typeof value.enabled!=='boolean' || !value.policy)throw fault('MEMORY_CONFIG_INVALID',400);
    const ranges={baseHalfLifeDays:[1,3650],emotionHalfLifeDays:[1,3650],maxItems:[1,30],dailyQuota:[1,30],threshold:[0,1]};
    const policy={...old.policy};
    for(const [k,v] of Object.entries(value.policy)) {
      if(!Object.hasOwn(ranges,k)) { if(v!==old.policy[k])throw fault('MEMORY_CONFIG_INVALID',400);continue; }
      const [min,max]=ranges[k];if(!Number.isFinite(v)||v<min||v>max||k!=='threshold'&&!Number.isInteger(v))throw fault('MEMORY_CONFIG_INVALID',400);policy[k]=v;
    }
    const data=memory.loadStore(memoryId);data.policy=policy;
    memory.saveStore(memoryId,data);
    if(JSON.stringify(memory.loadStore(memoryId).policy)!==JSON.stringify(policy))throw fault('MEMORY_SAVE_FAILED');
    fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify({enabled:value.enabled}));fs.renameSync(tmp,file);return read();
  }};
}
