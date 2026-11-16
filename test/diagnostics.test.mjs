import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {zstdCompressSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {collect,errorSummary} from '../scripts/diagnostics/collect.mjs';
import {ChatStore} from '../packages/conversation/store.mjs';
import {sandbox} from './helpers.mjs';

const token='synthetic-secret-never-export-this-987654321',body='PRIVATE_CHAT_TEXT_987654321';
const write=(file,text)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);};
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function server(t,handler,installed=false){const app=http.createServer(handler);let port=installed?37960:0;
 while(true){try{await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(port,'127.0.0.1',()=>{app.removeListener('error',reject);resolve();});});break;}catch(error){if(error.code!=='EADDRINUSE'||!installed||port>=37999)throw error;port++;}}
 t.after(()=>new Promise(r=>app.close(r)));return 'http://127.0.0.1:'+app.address().port+'/';}
function fixture(t){
 const {root}=sandbox(t),install=path.join(root,'安装目录 空格'),data=path.join(root,'用户资料'),dsh=path.join(root,'dsh'),bridge=path.join(data,'bridge');
 const sid='chatagent-12345678-1234-1234-1234-123456789abc',id='12345678-abcd-1234-1234-123456789abc';
 write(path.join(install,'app/package.json'),JSON.stringify({version:'0.4.6'}));
 for(const name of ['index.mjs','chat-dispatch.mjs'])write(path.join(install,'app/packages/dsh-bridge',name),fs.readFileSync(new URL('../packages/dsh-bridge/'+name,import.meta.url)));
 write(path.join(data,'bridge-token.txt'),token);write(path.join(bridge,'identity.json'),JSON.stringify({sessionId:sid}));
 const old=path.join(root,'old-copy/packages/dsh-bridge/index.mjs');write(old,'return assembly.tools.filter(tool=>true);');
 const patch=(profile,entry)=>write(path.join(dsh,'profiles',profile,'cordis.patch.yml'),`- insert:\n    - id: chatagent-bridge\n      name: ${pathToFileURL(entry).href}\n      config:\n        root: ${JSON.stringify(bridge)}\n        tokenFile: ${JSON.stringify(path.join(data,'bridge-token.txt'))}\n- id: unrelated-provider\n  config:\n    apiKey: ${token}\n`);
 patch('desktop',old);patch('web',path.join(install,'app/packages/dsh-bridge/index.mjs'));
 const store=new ChatStore(path.join(data,'chat.sqlite'));store.close();
 fs.mkdirSync(path.join(data,'chat'));fs.renameSync(path.join(data,'chat.sqlite'),path.join(data,'chat/chat.sqlite'));
 const chat=new ChatStore(path.join(data,'chat/chat.sqlite'));chat.publish({deliveryId:'private-fixture',text:body});chat.close();
 const requests=new DatabaseSync(path.join(root,'requests.sqlite'));requests.exec('CREATE TABLE requests(id TEXT,state TEXT,text TEXT)');requests.prepare('INSERT INTO requests VALUES(?,?,?)').run(id,'unknown',body);
 // Close before copying so the read-only fixture is self-contained.
 requests.close();write(path.join(bridge,'requests.sqlite'),fs.readFileSync(path.join(root,'requests.sqlite')));
 const error={message:`Cannot read properties of undefined (reading 'filter') ${token} ${body}`,stack:`TypeError: secret\n at call (C:\\private-user\\packages\\dsh-bridge\\index.mjs:94:21)`};
 write(path.join(bridge,'last-error.private.json'),JSON.stringify(error));
 write(path.join(data,'startup.stderr.log'),`${body}\n${token}\nECONNREFUSED\n`);
 const events=[{type:'session',version:4},{seq:1,type:'user/message',data:{source:{rpcId:id},content:[{text:body}]}},{seq:2,type:'turn/end',data:{reason:{kind:'error',error}}}];
 const native=path.join(dsh,'sessions/project',sid,'session.v4.jsonl.zstd');write(native,zstdCompressSync(Buffer.from(events.map(e=>JSON.stringify(e)).join('\n'))));
 return {root,install,data,dsh,bridge,id,sid,native,context:{installRoots:[install],dataRoots:[data],dshRoots:[dsh],processes:[{pid:456,exe:path.join(root,'DSH/DeepSeek Harness.exe'),version:'0.2.2-rc.1',startedAt:Date.now()-60000}]}};
}

test('diagnostics identifies copied old bridges and native errors, exports metadata only, and does not mutate chat or retry',async t=>{
 const f=fixture(t),seen=[];
 const url=await server(t,(req,res)=>{seen.push({method:req.method,url:req.url,auth:req.headers.authorization});res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/v1/bootstrap'?{backend:'dsh-bridge',token,persona:body}:{format:'chatagent-dsh-bridge-v1',sessionId:f.sid,connected:true,sessionReady:true,tools:[{description:body}],token}));},true);
 write(path.join(f.data,'installed-settings.json'),JSON.stringify({port:Number(new URL(url).port)}));
 write(path.join(f.data,'connection.json'),JSON.stringify({bridgeUrl:url,tokenFile:path.join(f.data,'bridge-token.txt')}));
 const before=[path.join(f.data,'chat/chat.sqlite'),path.join(f.bridge,'requests.sqlite'),f.native].map(sha);
 const report=await collect(f.context),text=JSON.stringify(report);
 assert.equal(report.bridges.length,2);assert.equal(report.bridges[0].oldToolsFilter,true);assert.equal(report.bridges[1].oldToolsFilter,false);
 assert.equal(report.bridges[0].requests.rows[0].state,'unknown');assert.equal(report.bridges[0].native.recentTurnEnds[0].kind,'error');
 assert.deepEqual(report.bridges[0].native.acceptedRequestIds,[f.id]);assert.ok(report.bridges[0].lastError.signatures.includes('UNDEFINED_FILTER'));
 assert.ok(report.bridges[0].lastError.locations.includes('packages/dsh-bridge/index.mjs:94:21'));
 assert.equal(report.applications[0].bridge.protocolMatches,true);assert.equal(report.applications[0].backend,'dsh-bridge');assert.ok(report.findings.some(s=>s.includes('旧 tools.filter')));
 for(const secret of [token,body,'private-user',f.root])assert.ok(!text.includes(secret));
 assert.deepEqual([path.join(f.data,'chat/chat.sqlite'),path.join(f.bridge,'requests.sqlite'),f.native].map(sha),before);
 assert.ok(seen.length>=1);assert.ok(seen.every(r=>r.method==='GET'&&['/v1/status','/v1/bootstrap'].includes(r.url)));assert.equal(seen.find(r=>r.url==='/v1/status').auth,'Bearer '+token);
});

test('diagnostics refuses remote token destinations, never follows redirects, and tolerates missing state',async t=>{
 const f=fixture(t);let leaked=0;
 const destination=await server(t,(_,res)=>{leaked++;res.end('{}');});
 const redirect=await server(t,(_,res)=>{res.writeHead(302,{Location:destination});res.end();});
 const config=path.join(f.data,'connection.json');write(config,JSON.stringify({bridgeUrl:'https://example.invalid/',tokenFile:path.join(f.data,'bridge-token.txt')}));
 let report=await collect(f.context);assert.equal(report.applications[0].bridge.http,'REFUSED_NON_LOOPBACK');
 write(config,JSON.stringify({bridgeUrl:redirect,tokenFile:path.join(f.data,'bridge-token.txt')}));
 report=await collect(f.context);assert.equal(report.applications[0].bridge.http,'HTTP_302');assert.equal(leaked,0);
 report=await collect({installRoots:[],dataRoots:[path.join(f.root,'missing')],dshRoots:[]});assert.equal(report.bridges.length,0);assert.ok(report.findings.length);
 assert.deepEqual(errorSummary({message:token+' '+body}),{signatures:['DETAIL_HIDDEN'],locations:[]});
});

test('Windows double-click collector locates bundled Node and creates a readable report without clipboard or UI in tests',{skip:process.platform!=='win32'},async t=>{
 const f=fixture(t),tool=path.join(f.root,'tool');fs.cpSync(fileURLToPath(new URL('../scripts/diagnostics',import.meta.url)),tool,{recursive:true});
 write(path.join(f.install,'runtime/node.exe'),fs.readFileSync(process.execPath));
 const {stdout}=await promisify(execFile)('powershell.exe',['-NoLogo','-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',path.join(tool,'collect.ps1'),'-InstallRoot',f.install,'-DataRoot',f.data,'-DshRoot',f.dsh,'-NoClipboard','-NoOpen'],{encoding:'utf8',windowsHide:true,timeout:20000});
 const reports=fs.readdirSync(tool).filter(s=>s.startsWith('诊断报告-'));assert.equal(reports.length,1);
 const text=fs.readFileSync(path.join(tool,reports[0]),'utf8');assert.match(text,/fish-with-me-diagnostics-v1/);assert.match(stdout,/报告位置/);
 assert.ok(!text.includes(token));assert.ok(!text.includes(body));assert.match(text,/UNDEFINED_FILTER/);
});
