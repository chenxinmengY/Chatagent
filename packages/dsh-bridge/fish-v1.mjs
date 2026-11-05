// Optional migration adapter. The fish engine remains installed and managed by DSH.
import {fishAdmin} from '../dsh-adapter/fish-admin.mjs';
export async function importMemory({sessionId,records,policy,options}){
  if(!options?.module||!options?.root)throw Error('FISH_MIGRATION_OPTIONS_REQUIRED');
  const memory=await import(options.module),admin=fishAdmin(memory,sessionId,options.root);
  const native=records.filter(r=>r.kind==='memory'&&r.metadata?.engine==='dsh-fish-memory'&&r.metadata.engineVersion==='1.5.0');
  if(!native.length)return {state:'no-compatible-records'};
  const groups=new Map();for(const row of native){const key=JSON.stringify([row.sourceId,row.scope]);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
  for(const rows of groups.values()){const p=admin.migrate({records:rows});if(p.conflicts)throw Error('FISH_IMPORT_CONFLICT');}
  for(const rows of groups.values()){const p=admin.migrate({records:rows});admin.migrate({...p,records:rows,apply:true});}
  if(policy){const data=memory.loadStore(sessionId);if(!policy||typeof policy!=='object'||Object.keys(policy).some(k=>!Object.hasOwn(data.policy,k)||!Number.isFinite(policy[k])||policy[k]<0||policy[k]>60000))throw Error('FISH_POLICY_INVALID');data.policy={...data.policy,...policy};memory.saveStore(sessionId,data);}
  const saved=admin.read();
  return {state:'imported',active:saved.memories.length,deleted:saved.deleted.length,engine:'dsh-fish-memory'};
}
