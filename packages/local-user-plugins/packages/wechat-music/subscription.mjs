import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';import {createRequire,registerHooks} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';import {execFileSync} from 'node:child_process';
const hostRequire=createRequire(process.env.CHATAGENT_DSH_PACKAGE??'C:/DSH/package.json');
const dshHome=process.env.CHATAGENT_DSH_HOME??path.join(os.homedir(),'.dsh');
const sourcePath=process.env.CHATAGENT_GEMINI_POOL_MODULE??path.join(dshHome,'profiles/desktop/node_modules/dsh-gemini-pool/lib/index.js');
const pinned='bcdd307a24a71582f32ca79b68ad076aa9809df10cf61f5ae506d2cbe1b0f0e0';
const poolPath=path.join(dshHome,'storages/antigravity-pool-accounts.json');
export const hash=b=>createHash('sha256').update(b).digest('hex');
export const accountHash=a=>hash(String(a.id??a.email??a.projectId??''));
let dispatcher;
export function subscriptionFetch(url,options){
 if(!dispatcher){const vars={};for(const line of fs.readFileSync(path.join(dshHome,'.env'),'utf8').split(/\r?\n/)){const m=line.match(/^\s*(HTTP_PROXY|HTTPS_PROXY|NO_PROXY)\s*=\s*(.*?)\s*$/);if(m)vars[m[1]]=m[2].replace(/^['"]|['"]$/g,'');}
  const {EnvHttpProxyAgent}=hostRequire('undici');dispatcher=new EnvHttpProxyAgent({httpProxy:vars.HTTP_PROXY,httpsProxy:vars.HTTPS_PROXY,noProxy:vars.NO_PROXY??'localhost,127.0.0.1'});}
 return hostRequire('undici').fetch(url,{...options,dispatcher});
}
let loading;
export function loadCodec(){return loading??=(async()=>{
 const source=fs.readFileSync(sourcePath,'utf8');if(hash(source)!==pinned)throw Error('AUDIO_CODEC_REVISION_CHANGED');
 const anchor='return await fetch(TOKEN_URL, init);';if(source.split(anchor).length!==2)throw Error('AUDIO_CODEC_REFRESH_ANCHOR');
 const scoped='import {subscriptionFetch as musicFetch} from '+JSON.stringify(import.meta.url)+';\n'+source.replace(anchor,'return await musicFetch(TOKEN_URL, init);');
 const url='data:text/javascript;base64,'+Buffer.from(scoped+'\nexport const musicCodec={buildRequest,createStreamState,streamResponseToChunks,antigravityHeaders,resolveReasoning,refreshAntigravityToken};').toString('base64');
 const parent=pathToFileURL(sourcePath).href,folder=new URL('.',parent).href;
 const hook=registerHooks({resolve(s,c,n){if(c.parentURL===url||c.parentURL?.startsWith(folder)){if(s.startsWith('@deepseek-ai/'))return {url:pathToFileURL(hostRequire.resolve(s)).href,shortCircuit:true};if(c.parentURL===url&&s.startsWith('.'))return n(new URL(s,parent).href,c);}return n(s,c);}});
 try{const plugin=await import(url),adapter=new plugin.AntigravityPoolAdapter({},{read:async()=>({})});return {...plugin.musicCodec,model:await adapter.resolveModel('antigravity','gemini-3.8-flash'),sourceSha256:pinned};}finally{hook.deregister();}
})();}
const helper=fileURLToPath(new URL('./credential.ps1',import.meta.url));
function dpapi(mode,input){try{return execFileSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-File',helper,'-Mode',mode],{input,encoding:'utf8',windowsHide:true,stdio:['pipe','pipe','pipe'],timeout:10000}).trim();}catch{throw Error('MUSIC_DPAPI_UNAVAILABLE');}}
export async function obtainCredential(expectedHash){
 assertNoRefreshRecovery();
 if(!/^[a-f0-9]{64}$/.test(expectedHash))throw Error('MUSIC_SUBSCRIPTION_SCOPE');
 const before=fs.readFileSync(poolPath),pool=JSON.parse(before),a=selectAccount(pool,expectedHash);
 const codec=await loadCodec(),file=new URL('./state/credential.dpapi',import.meta.url);
 if(fs.existsSync(file)){const c=JSON.parse(dpapi('unprotect',fs.readFileSync(file)));if(c.accountHash!==expectedHash)throw Error('MUSIC_SUBSCRIPTION_SCOPE');if(c.expires>Date.now()+120000)return {credential:c,codec};}
 let current=a;
 if(!a.access||a.expires<=Date.now()+120000){
  try{current=await codec.refreshAntigravityToken({...a});}catch{throw Error('MUSIC_SUBSCRIPTION_REFRESH_FAILED');}
  if(current.refresh!==a.refresh){fs.writeFileSync(new URL('./state/refresh-recovery.dpapi',import.meta.url),dpapi('protect',JSON.stringify(current)),{mode:0o600,flag:'wx'});throw Error('MUSIC_REFRESH_ROTATED_RECOVERY_REQUIRED');}
 }
 const c={token:current.access,projectId:current.projectId,expires:current.expires,accountHash:expectedHash};
 if(hash(before)!==hash(fs.readFileSync(poolPath)))throw Error('MUSIC_ACCOUNT_POOL_CHANGED');
 fs.writeFileSync(file,dpapi('protect',JSON.stringify(c)),{mode:0o600});return {credential:c,codec};
}
export function assertNoRefreshRecovery(file=new URL('./state/refresh-recovery.dpapi',import.meta.url)){
 if(fs.existsSync(file))throw Error('MUSIC_REFRESH_ROTATED_RECOVERY_REQUIRED');
}
export function selectAccount(pool,expectedHash,now=Date.now()){
 const matches=(pool?.accounts??[]).filter(a=>accountHash(a)===expectedHash);
 if(matches.length!==1)throw Error('MUSIC_SUBSCRIPTION_SCOPE');const a=matches[0];
 if(a.status==='disabled'||a.cooldownUntil>now||!a.refresh||!a.projectId)throw Error('MUSIC_SUBSCRIPTION_UNAVAILABLE');return a;
}
