import fs from 'node:fs';
import path from 'node:path';
import {createIsolatedDshRuntime} from '../packages/dsh-adapter/isolated-runtime.mjs';
import {createFishCompanion} from '../packages/dsh-adapter/fish-companion.mjs';
import {createModelRouter} from '../packages/dsh-adapter/model-connections.mjs';
import {startService} from '../apps/service/server.mjs';
const file=process.argv[2];if(!file)throw Error('USAGE: node scripts/start-workspace.mjs <configuration.json>');
const config=JSON.parse(fs.readFileSync(path.resolve(file),'utf8'));
if(![config.dataRoot,config.sdkRoot,config.fishRoot].every(p=>typeof p==='string'&&path.isAbsolute(p)))throw Error('ABSOLUTE_PATHS_REQUIRED');
const router=createModelRouter(),runtime=await createIsolatedDshRuntime({dataRoot:path.join(config.dataRoot,'dsh'),sdkRoot:config.sdkRoot,adapterFactory:router.adapterFactory,modelRouter:router,companionFactory:({root})=>createFishCompanion({root:path.join(root,'workspaces/companion'),fishRoot:config.fishRoot,persona:config.persona})});
let service;
try{service=await startService({dataRoot:path.join(config.dataRoot,'chat'),port:config.port??37825,backend:runtime,modelOptions:{allowNetwork:config.allowNetwork===true}});}catch(e){await runtime.close();throw e;}
console.log(JSON.stringify({url:service.url,workspace:config.dataRoot,allowNetwork:config.allowNetwork===true}));
let closing;const close=()=>closing??=(async()=>{await service.close();await runtime.close();})();process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
