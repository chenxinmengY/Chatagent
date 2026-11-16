import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {WINDOW_SOURCE} from '../../packages/dsh-bridge/chat-continuity.mjs';
const base=fs.realpathSync(os.tmpdir()),root=fs.mkdtempSync(path.join(base,'chatagent-fish-continuity-'));
fs.writeFileSync(path.join(root,'.owned-test-directory'),'synthetic-only');
process.env.DSH_HOME=root;
let networkCalls=0;
globalThis.fetch=async()=>{networkCalls++;throw Error('NETWORK_DISABLED_IN_FIXTURE');};
try{
 const file=path.join(os.homedir(),'.dsh/profiles/desktop/node_modules/dsh-fish-memory/lib/index.js');
 const memory=await import(pathToFileURL(file));
 const text='之前提到星云展览，你也想看那个展览',wrapped='Chatagent 聊天资料。此处是打包历史，不是用户这一轮的话。';
 const event=(kind,text)=>({type:'user/message',data:{source:{kind},content:[{type:'text',text}]}});
 assert.equal(memory.挑这一轮的真话([event('user',text),event('chatagent-window',wrapped)]),wrapped,'Reproduces the original bridge/plugin mismatch');
 assert.equal(memory.挑这一轮的真话([event('user',text),event(WINDOW_SOURCE,wrapped),event('runtime-context','irrelevant')]),text);
 assert.equal(networkCalls,0);
 console.log(JSON.stringify({ok:true,installedFishPlugin:true,oldMismatchReproduced:true,realUserQueryRestored:true,productionStoreUntouched:true,externalCalls:0}));
}finally{
 const resolved=fs.realpathSync(root);
 if(path.dirname(resolved).toLowerCase()!==base.toLowerCase()||!path.basename(resolved).startsWith('chatagent-fish-continuity-')||fs.readFileSync(path.join(resolved,'.owned-test-directory'),'utf8')!=='synthetic-only')throw Error('CLEANUP_BOUNDARY_INVALID');
 fs.rmSync(resolved,{recursive:true});
}
