import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {startService} from '../service/server.mjs';
import {createDshBridgeRuntime} from '../../packages/dsh-adapter/bridge-runtime.mjs';
import {readDeviceTlsOptions} from '../../packages/devices/tls-config.mjs';

// Installed builds keep all writable state outside the application directory.
const settings=path.resolve(process.argv[2]);
const config=JSON.parse(fs.readFileSync(settings,'utf8').replace(/^\uFEFF/,''));
if(!path.isAbsolute(config.dataRoot)||!Number.isInteger(config.port)||config.port<37821||config.port>37999)throw Error('INSTALL_SETTINGS_INVALID');
process.on('uncaughtException',error=>{
  fs.appendFileSync(path.join(config.dataRoot,'startup.stderr.log'),String(error.stack??error)+'\n');process.exit(1);
});
const connectionFile=path.join(config.dataRoot,'connection.json');
let runtime=null,device={};
if(fs.existsSync(connectionFile)){
  const connection=JSON.parse(fs.readFileSync(connectionFile,'utf8').replace(/^\uFEFF/,''));
  if(!path.isAbsolute(connection.tokenFile))throw Error('ABSOLUTE_TOKEN_PATH_REQUIRED');
  // A configured connection must succeed. Never silently replace it with an empty space.
  runtime=await createDshBridgeRuntime({url:connection.bridgeUrl,token:fs.readFileSync(connection.tokenFile,'utf8').trim()});
  if(connection.device)device=readDeviceTlsOptions(connection.device);
}
let service;
try{service=await startService({dataRoot:path.join(config.dataRoot,'chat'),port:config.port,backend:runtime,workspaceAutomaticBackups:!!runtime,...device});}
catch(error){await runtime?.close();throw error;}
const controlFile=path.join(config.dataRoot,'service-control.json'),stopFile=path.join(config.dataRoot,'stop-request.json'),nonce=randomUUID();
fs.writeFileSync(controlFile,JSON.stringify({pid:process.pid,nonce}));
let stopping=false;
async function stop(){
  if(stopping)return;stopping=true;clearInterval(watcher);
  await service.close();await runtime?.close();
  if(JSON.parse(fs.readFileSync(controlFile,'utf8')).nonce===nonce)fs.unlinkSync(controlFile);
  fs.rmSync(stopFile,{force:true});
}
const watcher=setInterval(()=>{
  try{if(JSON.parse(fs.readFileSync(stopFile,'utf8').replace(/^\uFEFF/,'')).nonce===nonce)void stop().catch(()=>{process.exitCode=1;});}catch{}
},300);
watcher.unref();
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
fs.writeFileSync(path.join(config.dataRoot,'startup.stdout.log'),JSON.stringify({url:service.url,backend:runtime?'dsh-bridge':'not-connected'}));
