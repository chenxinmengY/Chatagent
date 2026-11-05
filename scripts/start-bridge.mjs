import fs from 'node:fs';
import path from 'node:path';
import {createDshBridgeRuntime} from '../packages/dsh-adapter/bridge-runtime.mjs';
import {startService} from '../apps/service/server.mjs';
import {readDeviceTlsOptions} from '../packages/devices/tls-config.mjs';
if(!process.argv[2])throw Error('USAGE: node scripts/start-bridge.mjs <configuration.json>');
const config=JSON.parse(fs.readFileSync(path.resolve(process.argv[2])));
if(!path.isAbsolute(config.dataRoot)||!path.isAbsolute(config.tokenFile))throw Error('ABSOLUTE_PATHS_REQUIRED');
const runtime=await createDshBridgeRuntime({url:config.bridgeUrl,token:fs.readFileSync(config.tokenFile,'utf8').trim()});
let service;try{service=await startService({dataRoot:path.join(config.dataRoot,'chat'),port:config.port??37824,backend:runtime,...(config.device?readDeviceTlsOptions(config.device):{})});}catch(e){await runtime.close();throw e;}
console.log(JSON.stringify({url:service.url,backend:'dsh-bridge'}));
const stop=async()=>{await service.close();await runtime.close();};process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
