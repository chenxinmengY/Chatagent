import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {zstdDecompressSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';

const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const stat=file=>{try{return fs.statSync(file);}catch{return null;}};
const json=file=>{try{if(stat(file)?.size>1048576)return null;return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{return null;}};
const dirs=root=>{try{return fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.isSymbolicLink()).slice(0,2000).map(e=>path.join(root,e.name));}catch{return [];}};
const scalar=line=>{const value=line.slice(line.indexOf(':')+1).trim().replace(/\s+#.*$/,'');if(value.startsWith('"')){try{return JSON.parse(value);}catch{return '';}}return value.replace(/^'(.*)'$/,'$1').replaceAll("''", "'");};
const kinds=new Set(['completed','error','aborted','cancelled','unknown','running','queued','awaiting_confirmation','stopping','idle','ready','not-connected','dsh-bridge','social','assistant','user','tool']);
const kind=value=>kinds.has(value)?value:'other';
const version=value=>/^\d+\.\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?$/.test(value??'')?value:'unknown';

// No free-form message, error text, configuration value or log line is exported.
// Keep fixed error signatures and code locations; unknown details stay hidden.
export function errorSummary(value){
 const text=(typeof value==='string'?value:JSON.stringify(value??{})).replaceAll('\\\\','/'),signatures=[];
 for(const [name,pattern] of [
  ['UNDEFINED_FILTER',/Cannot read properties of (?:undefined|null) \(reading ['"]filter['"]\)/],
  ['UNDEFINED_PROPERTY',/Cannot read properties of (?:undefined|null)/],
  ['NOT_A_FUNCTION',/is not a function/],['MODULE_NOT_FOUND',/ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/],
  ['CONNECTION_REFUSED',/ECONNREFUSED/],['TIMEOUT',/TimeoutError|ETIMEDOUT|timed out/i],
  ['AUTH_FAILURE',/BRIDGE_AUTH_REQUIRED|unauthorized|invalid.api.key|\b401\b/i],
  ['RATE_LIMIT',/rate.limit|\b429\b/i],['MODEL_NOT_READY',/MODEL_NOT_READY|model.not.found/i],
  ['SESSION_MISMATCH',/BRIDGE_SESSION_CHANGED|BRIDGE_SESSION_MISMATCH/],
  ['BRIDGE_OPERATION_FAILED',/BRIDGE_OPERATION_FAILED/],['NETWORK_FAILURE',/fetch failed|ENOTFOUND|ECONNRESET/],
 ])if(pattern.test(text))signatures.push(name);
 const locations=[...text.matchAll(/(?:packages[\\/]dsh-bridge|@deepseek-ai[\\/]dsh-[a-z-]{1,60})[\\/](?:lib[\\/])?([a-z.-]{1,60}):([0-9]{1,7}):([0-9]{1,7})/g)].map(m=>m[0].replaceAll('\\','/'));
 return {signatures:signatures.length?signatures:['DETAIL_HIDDEN'],locations:[...new Set(locations)].slice(0,8)};
}

function tail(file,limit=262144){
 let fd;try{const size=stat(file)?.size??0;if(!size)return '';fd=fs.openSync(file,'r');const buffer=Buffer.alloc(Math.min(size,limit));fs.readSync(fd,buffer,0,buffer.length,Math.max(0,size-limit));return buffer.toString('utf8');}catch{return '';}finally{if(fd!==undefined)fs.closeSync(fd);}
}

// Explicit HTTP GET only. Never follow redirects, use a proxy, or send a token
// to a host supplied by arbitrary configuration.
async function get(base,route,token){
 let url;try{url=new URL(base);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw Error();}catch{return {state:'REFUSED_NON_LOOPBACK'};}
 return new Promise(resolve=>{
  let request;const deadline=setTimeout(()=>{request?.destroy();done({state:'TIMEOUT'});},3500);
  const done=value=>{clearTimeout(deadline);resolve(value);};
  request=http.get(new URL(route,url),{agent:false,headers:token?{Authorization:'Bearer '+token}:{}},response=>{
   const chunks=[];let bytes=0;
   response.on('data',chunk=>{bytes+=chunk.length;if(bytes>524288){response.destroy();done({state:'RESPONSE_TOO_LARGE'});}else chunks.push(chunk);});
   response.on('error',()=>done({state:'RESPONSE_INTERRUPTED'}));
   response.on('end',()=>{let value;try{value=JSON.parse(Buffer.concat(chunks));}catch{}done({state:'HTTP_'+response.statusCode,value});});
  });
  request.setTimeout(2500,()=>{request.destroy();done({state:'TIMEOUT'});});
  request.on('error',()=>done({state:'CONNECTION_FAILED'}));
 });
}

function database(file,sql){
 if(!stat(file))return {state:'NOT_FOUND'};
 if(stat(file+'-wal')&&!stat(file+'-shm'))return {state:'WAL_WITHOUT_SHM_SKIPPED'};
 let db;try{db=new DatabaseSync(file,{readOnly:true});return {state:'READ_ONLY',rows:db.prepare(sql).all()};}catch{return {state:'READ_FAILED'};}finally{db?.close();}
}

function bridgeEntries(file){
 if(!stat(file)||stat(file).size>2097152)return [];
 const lines=fs.readFileSync(file,'utf8').split(/\r?\n/),result=[];
 for(let i=0;i<lines.length;i++){
  if(!/^\s*(?:-\s*)?name:\s*/.test(lines[i]))continue;
  const name=scalar(lines[i]);let entry;
  try{entry=fileURLToPath(name);}catch{continue;}
  if(!/[\\/]packages[\\/]dsh-bridge[\\/]index\.mjs$/i.test(entry))continue;
  let start=i;
  while(start>0&&!/^\s*-\s+(?:id|name):/.test(lines[start]))start--;
  const indent=lines[start].search(/\S/);let end=start+1;
  while(end<lines.length&&!(/\S/.test(lines[end])&&lines[end].search(/\S/)<=indent))end++;
  const config={};for(const line of lines.slice(start,end)){const key=/^\s*(root|cwd|tokenFile|port|llmModule|compactionModule):/.exec(line)?.[1];if(key)config[key]=scalar(line);}
  result.push({entry,config});
 }
 return result;
}

function nativeEvents(dshRoot,sessionId,requestIds){
 const roots=[path.join(dshRoot,'sessions'),path.join(dshRoot,'storages/sessions')];
 for(const root of roots)for(const folder of [path.join(root,sessionId),...dirs(root).map(project=>path.join(project,sessionId))]){
  for(const name of ['session.v4.jsonl','session.v4.jsonl.zstd']){
   const file=path.join(folder,name),info=stat(file);if(!info)continue;
   if(info.size>8388608)return {state:'FILE_TOO_LARGE'};
   try{
    let bytes=fs.readFileSync(file);if(name.endsWith('.zstd'))bytes=zstdDecompressSync(bytes,{maxOutputLength:33554432});
    const ends=[],accepted=[];let lines=0;
    for(const line of bytes.toString('utf8').split('\n')){if(!line.trim())continue;let event;try{event=JSON.parse(line);}catch{continue;}lines++;
     if(event.type==='user/message'&&requestIds.includes(event.data?.source?.rpcId))accepted.push(event.data.source.rpcId);
     if(event.type==='turn/end'){const reason=event.data?.reason;ends.push({seq:Number(event.seq)||0,kind:kind(reason?.kind),...reason?.kind==='error'?{error:errorSummary(reason.error)}:{}});}
    }
    return {state:'READ_ONLY',format:name.endsWith('.zstd')?'zstd':'jsonl',eventCount:lines,acceptedRequestIds:[...new Set(accepted)],recentTurnEnds:ends.slice(-5)};
   }catch{return {state:'READ_FAILED'};}
  }
 }
 return {state:'NOT_FOUND'};
}

export async function collect(context){
 const installs=[...new Set(context.installRoots??[])].filter(p=>typeof p==='string'&&path.isAbsolute(p));
 const dataRoots=[...new Set(context.dataRoots??[])].filter(p=>typeof p==='string'&&path.isAbsolute(p));
 const dshRoots=[...new Set(context.dshRoots??[])].filter(p=>typeof p==='string'&&path.isAbsolute(p));
 const labels=[...installs.map((root,i)=>[root,'<APP'+(i+1)+'>']),...dataRoots.map((root,i)=>[root,'<DATA'+(i+1)+'>']),...dshRoots.map((root,i)=>[root,'<DSH'+(i+1)+'>'])].sort((a,b)=>b[0].length-a[0].length);
 const location=file=>{if(typeof file!=='string')return 'unknown';for(const [root,label] of labels){const relative=path.relative(root,file);if(relative===''||!relative.startsWith('..')&&!path.isAbsolute(relative))return label+'/'+relative.replaceAll('\\','/');}return '<OTHER>/'+path.basename(file).replace(/[^a-zA-Z0-9._-]/g,'_');};
 const known=json(path.join(path.dirname(fileURLToPath(import.meta.url)),'known-build.json'));
 const report={format:'fish-with-me-diagnostics-v1',time:new Date().toISOString(),scope:'只读诊断；不发送模型请求，不导出密钥、聊天正文或原始日志。磁盘版本不能证明进程已重新加载。',node:process.version,installs:[],applications:[],bridges:[],processes:[],logErrors:[],findings:[]};
 for(const root of installs){const pkg=json(path.join(root,'app/package.json'));report.installs.push({location:location(root),version:version(pkg?.version),bridgeHash:stat(path.join(root,'app/packages/dsh-bridge/index.mjs'))?hash(path.join(root,'app/packages/dsh-bridge/index.mjs')):null});}
 const processes=(context.processes??[]).slice(0,30);
 report.processes=processes.map(p=>({pid:Number(p.pid)||0,executable:location(p.exe),version:version(p.version),startedAt:Number.isFinite(p.startedAt)?new Date(p.startedAt).toISOString():null}));
 for(const root of dataRoots){
  const settings=json(path.join(root,'installed-settings.json')),connection=json(path.join(root,'connection.json'));
  const app={location:location(root),settingsFound:!!settings,connectionFound:!!connection};
  if(Number.isInteger(settings?.port)&&settings.port>=37821&&settings.port<=37999){const response=await get('http://127.0.0.1:'+settings.port+'/', '/v1/bootstrap');app.http=response.state;app.backend=kind(response.value?.backend);}
  const rows=database(path.join(root,'chat/chat.sqlite'),"SELECT id,role,state,created_at FROM messages ORDER BY seq DESC LIMIT 10");
  app.recentMessages={...rows,rows:rows.rows?.map(r=>({id:r.id,role:kind(r.role),state:kind(r.state),createdAt:Number(r.created_at)}))};
  if(connection){let token;try{if(path.isAbsolute(connection.tokenFile)&&stat(connection.tokenFile)?.size<=8192)token=fs.readFileSync(connection.tokenFile,'utf8').trim();}catch{}
   const tokenValid=/^[\x21-\x7e]{32,8192}$/.test(token??'');if(!tokenValid)token=undefined;
   const response=await get(connection.bridgeUrl,'/v1/status',token),value=response.value;
   app.bridge={http:response.state,tokenFileValid:tokenValid,protocolMatches:value?.format==='chatagent-dsh-bridge-v1',connected:value?.connected===true,sessionReady:value?.sessionReady===true,busy:value?.busy===true};
   if(/^chatagent-[a-f0-9-]{36}$/.test(value?.sessionId??''))app.bridge.sessionId=value.sessionId;
  }
  const startup=tail(path.join(root,'startup.stderr.log'));if(startup)report.logErrors.push({file:location(path.join(root,'startup.stderr.log')),...errorSummary(startup)});
  report.applications.push(app);
 }
 const seen=new Set();
 for(const root of dshRoots){
  const profiles=[root,...dirs(path.join(root,'profiles'))];
  for(const profile of profiles)for(const name of ['cordis.patch.yml','cordis.patch.yaml','cordis.yml'])for(const {entry,config} of bridgeEntries(path.join(profile,name))){
   const key=profile+'\0'+entry;if(seen.has(key))continue;seen.add(key);
   const info=stat(entry),bridge={config:location(path.join(profile,name)),entry:location(entry),exists:!!info};
   if(info&&info.size<=1048576){const text=fs.readFileSync(entry,'utf8');bridge.sha256=hash(entry);bridge.oldToolsFilter=/assembly\.tools\.filter/.test(text);bridge.matchesKnown046=known?.bridgeHash?bridge.sha256===known.bridgeHash:null;
    const dispatch=path.join(path.dirname(entry),'chat-dispatch.mjs');bridge.dispatchHash=stat(dispatch)?hash(dispatch):null;bridge.dispatchMatchesKnown046=known?.dispatchHash?bridge.dispatchHash===known.dispatchHash:null;
    const dshStarts=processes.filter(p=>/dsh|deepseek/i.test(p.exe??'')&&!/chatagent/i.test(p.exe??'')).map(p=>p.startedAt).filter(Number.isFinite);
    bridge.fileNewerThanDshProcess=dshStarts.length?info.mtimeMs>Math.max(...dshStarts):null;
    if(bridge.oldToolsFilter)report.findings.push('配置仍指向包含旧 tools.filter 的桥接文件，覆盖安装可能没有更新这个入口。');
    if(bridge.matchesKnown046===false||bridge.dispatchMatchesKnown046===false)report.findings.push('该配置指向的桥接文件与本次 0.4.6 修复包不一致。');
    if(bridge.fileNewerThanDshProcess)report.findings.push('桥接文件的修改时间晚于已发现的 DSH 进程启动时间，可能尚未重新加载。');
   }else report.findings.push('桥接入口文件缺失或过大，需检查配置路径。');
   if(config.llmModule){try{const module=fileURLToPath(config.llmModule);bridge.sdkLlmVersion=version(json(path.join(path.dirname(module),'../package.json'))?.version);}catch{bridge.sdkLlmVersion='unknown';}}
   if(config.root&&path.isAbsolute(config.root)){
    const identity=json(path.join(config.root,'identity.json')),lastError=json(path.join(config.root,'last-error.private.json'));
    if(lastError)bridge.lastError=errorSummary(lastError);
    const ledger=database(path.join(config.root,'requests.sqlite'),'SELECT id,state FROM requests ORDER BY rowid DESC LIMIT 10');
    bridge.requests={...ledger,rows:ledger.rows?.map(r=>({id:/^[a-zA-Z0-9_-]{1,150}$/.test(r.id)?r.id:'hidden',state:kind(r.state)}))};
    if(/^chatagent-[a-f0-9-]{36}$/.test(identity?.sessionId??'')){bridge.sessionId=identity.sessionId;bridge.native=nativeEvents(root,identity.sessionId,ledger.rows?.map(r=>r.id)??[]);}
   }
   report.bridges.push(bridge);
  }
 }
 if(!report.bridges.length)report.findings.push('已检查的位置没有发现桥接配置；可能使用了其他 DSH 资料目录或配置写入了其他 profile。');
 if(!report.applications.some(a=>a.bridge?.protocolMatches))report.findings.push('没有在已发现的应用配置中验证到可访问且认证成功的桥接。');
 report.findings=[...new Set(report.findings)];if(!report.findings.length)report.findings.push('未发现明确的路径或版本问题，请结合最近的 DSH 回合结果继续排查。');
 return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const context=JSON.parse(fs.readFileSync(0,'utf8').replace(/^\uFEFF/,'')),report=await collect(context);fs.writeFileSync(process.argv[2],'fish with me 诊断报告\r\n把本文件全部复制发回即可。\r\n\r\n'+JSON.stringify(report,null,2),'utf8');}
 catch{fs.writeFileSync(process.argv[2],'fish with me 诊断报告\r\n诊断工具读取失败，未修改软件配置。请确认已解压完整工具包，并保持软件和 DSH 打开。','utf8');process.exitCode=1;}
}
