import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {sandbox} from './helpers.mjs';
import {wav} from '../packages/companion-capabilities/media.mjs';
import {VoiceReplies,inspectVoiceWav,runSystemVoice} from '../packages/companion-capabilities/system-voice.mjs';
import {startService} from '../apps/service/server.mjs';
import {startDshBridgeHost} from '../packages/dsh-bridge/host.mjs';
import {createDshBridgeRuntime} from '../packages/dsh-adapter/bridge-runtime.mjs';
import {nativeBackupSnapshot} from '../packages/dsh-bridge/backup.mjs';

function fixture(t,{voices=[{name:'Synthetic Chinese Voice',culture:'zh-CN'}],legacy=null,run}={}){
  const {root}=sandbox(t),calls=[];
  const voice=new VoiceReplies({root,platform:'win32',legacy,run:run??(async request=>{calls.push(request);if(request.action==='voices')return voices;fs.writeFileSync(request.file,wav(Buffer.alloc(48000)));return {completed:true};})});
  return {voice,root,calls};
}

test('one click uses an installed Chinese voice, validates actual output before saving and does not start the old AI engine',async t=>{
  let oldCalls=0;const legacy={synthesize:async()=>{oldCalls++;return {legacy:true};},close:async()=>{}};
  const {voice,root,calls}=fixture(t,{legacy});
  assert.equal(voice.read().source,'existing');assert.equal(fs.existsSync(voice.file),false);
  assert.equal((await voice.synthesize({text:'original'})).legacy,true);
  await voice.setup({source:'system'});assert.equal(voice.read().source,'system');assert.equal(oldCalls,1);
  assert.equal(calls[1].text,'你好，我已经准备好用语音回复你了。');
  const requestText='你好，$() ` " 测试文字';const output=await voice.synthesize({directory:root,id:'reply',text:requestText});
  assert.equal(inspectVoiceWav(output.file).seconds,1);assert.equal(calls.at(-1).text,requestText);
  const sample=await voice.preview();assert.equal(sample.mediaType,'audio/wav');assert.equal(Buffer.from(sample.data,'base64').toString('ascii',0,4),'RIFF');
  assert.deepEqual(fs.readdirSync(voice.root),['settings.json']);
  const reopened=new VoiceReplies({root,legacy});assert.equal(reopened.read().source,'system');
  await voice.setup({source:'existing'});assert.equal(voice.read().source,'existing');assert.equal((await voice.synthesize({})).legacy,true);await voice.close();
});

test('missing Chinese voices, bad audio and native errors leave the original voice selection untouched',async t=>{
  const missing=fixture(t,{voices:[{name:'English only',culture:'en-US'}]});
  await assert.rejects(missing.voice.setup({source:'system'}),/CHINESE_MISSING/);assert.equal(fs.existsSync(missing.voice.file),false);
  const legacy={synthesize:async()=>({old:true})};
  const corrupt=fixture(t,{legacy,run:async request=>{if(request.action==='voices')return [{name:'Test',culture:'zh-CN'}];fs.writeFileSync(request.file,'not audio');return {completed:true};}});
  await assert.rejects(corrupt.voice.setup({source:'system'}),/AUDIO_INVALID/);assert.equal(corrupt.voice.read().source,'existing');
  await assert.rejects(corrupt.voice.systemAudio({directory:corrupt.root,id:'../outside',text:'x',voice:'x'}),/REQUEST_INVALID/);
  const file=path.join(corrupt.root,'keep.wav');fs.writeFileSync(file,'keep');
  await assert.rejects(corrupt.voice.systemAudio({directory:corrupt.root,id:'keep',text:'x',voice:'x'}),/OUTPUT_EXISTS/);assert.equal(fs.readFileSync(file,'utf8'),'keep');
  const other=new VoiceReplies({root:missing.root,platform:'linux'});await assert.rejects(other.setup({source:'system'}),/WINDOWS_REQUIRED/);
});

test('parallel configuration is refused and closing an active setup cannot commit a new voice',async t=>{
  let started;const began=new Promise(resolve=>started=resolve);
  const {voice}=fixture(t,{run:async(request,{signal})=>{started();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('VOICE_REPLY_CANCELLED')),{once:true}));}});
  const pending=voice.setup({source:'system'});await began;
  await assert.rejects(voice.setup({source:'system'}),/VOICE_REPLY_BUSY/);
  await voice.close();await assert.rejects(pending,/CANCELLED/);assert.equal(fs.existsSync(voice.file),false);
});

test('desktop one-click setup traverses the bridge, preserves tool grants, rejects stale settings and keeps audio out of chat history',async t=>{
  let cleanup;const f=fixture({after:fn=>cleanup=fn});let host,service,runtime;
  t.after(async()=>{try{await service?.close();await runtime?.close();await host?.close();await f.voice.close();}finally{cleanup();}});
  const token='synthetic-voice-bridge-'.padEnd(64,'x');
  const driver={configure(){},ensure:async()=>{},status:()=>({connected:true,tools:[],plugins:[]}),voiceReplies:()=>f.voice.read(),setupVoiceReplies:value=>f.voice.setup(value),previewVoiceReplies:()=>f.voice.preview()};
  host=await startDshBridgeHost({root:path.join(f.root,'bridge'),token,port:0,driver});
  runtime=await createDshBridgeRuntime({url:host.url,token});
  service=await startService({dataRoot:path.join(f.root,'chat'),backend:runtime,devicePort:0});
  const boot=await(await fetch(service.url+'/v1/bootstrap')).json(),headers={'X-Chatagent-Token':boot.token,'Content-Type':'application/json'};
  const call=async(route,body,auth=headers)=>{const response=await fetch(service.url+route,{headers:auth,method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,value:await response.json()};};
  assert.equal((await call('/v1/voice-replies',undefined,{})).status,401);
  const initial=(await call('/v1/voice-replies')).value;
  const policy=await call('/v1/chat-settings',{sessionId:initial.sessionId,revision:initial.revision,allowedTools:['remember']});assert.equal(policy.status,200);
  assert.equal((await call('/v1/voice-replies/setup',{source:'system',sessionId:initial.sessionId,revision:initial.revision})).value.error,'VOICE_REPLY_SETTINGS_CHANGED');
  const current=(await call('/v1/voice-replies')).value;
  const setup=await call('/v1/voice-replies/setup',{source:'system',sessionId:current.sessionId,revision:current.revision});assert.equal(setup.status,200);assert.deepEqual(setup.value.allowedTools,['remember','chatagent_send_voice']);
  const preview=await call('/v1/voice-replies/preview',{sessionId:setup.value.sessionId,revision:setup.value.revision});assert.equal(preview.status,200);assert.equal(preview.value.mediaType,'audio/wav');
  assert.equal(service.store.history().length,0);
  const invite=(await call('/v1/pairing/invitations',{})).value,deviceToken='b'.repeat(64);
  const claim=await fetch(service.deviceUrl+'/v1/pairing/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({credential:invite.credential,deviceToken,name:'Synthetic phone'})});assert.equal(claim.status,200);
  for(const route of ['/v1/voice-replies/setup','/v1/chats/'+randomUUID()+'/v1/voice-replies/setup']){
    const device=await fetch(service.deviceUrl+route,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+deviceToken},body:'{}'});assert.equal(device.status,403);
  }
});

test('voice setup remains in its selected chat and pauses dispatch, permission edits and backups until committed',async t=>{
  let cleanup;const box=sandbox({after:fn=>cleanup=fn}),states=new Map();let release,started,replyCalls=0;
  const began=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
  const backend=id=>{
    const state={source:'none',voice:null,hasExisting:false,systemSupported:true};states.set(id,state);
    return {kind:'voice-fixture',status:()=>({modeBindings:[{mode:'social',session_id:'session-'+id}]}),openChat:async id=>backend(id),voiceReplies:async()=>state,
      setupVoiceReplies:async()=>{if(id==='default'){started();await gate;}state.source='system';state.voice='Synthetic Chinese';},previewVoiceReplies:async()=>({mediaType:'audio/wav'}),reply:async()=>{replyCalls++;return 'Synthetic reply';}};
  };
  const service=await startService({dataRoot:path.join(box.root,'chat'),backend:backend('default'),preferencesSeed:{personas:[{id:'synthetic',name:'Synthetic',text:'Synthetic test persona',categoryId:null}],activePersonaId:'synthetic'}});
  t.after(async()=>{release();await service.close();cleanup();});
  const boot=await(await fetch(service.url+'/v1/bootstrap')).json(),headers={'X-Chatagent-Token':boot.token,'Content-Type':'application/json'};
  const call=async(route,body)=>{const response=await fetch(service.url+route,{headers,method:body===undefined?'GET':'POST',...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,value:await response.json()};};
  const chats=(await call('/v1/chats')).value,id=randomUUID(),prefix='/v1/chats/'+id;
  const created=await call('/v1/chats',{id,name:'Synthetic second chat',personaId:chats.chats[0].personaId});assert.equal(created.status,200);
  const child=(await call(prefix+'/v1/voice-replies')).value;
  const childSetup=await call(prefix+'/v1/voice-replies/setup',{source:'system',sessionId:child.sessionId,revision:child.revision});assert.equal(childSetup.status,200);
  assert.equal(states.get(id).source,'system');assert.equal(states.get('default').source,'none');assert.deepEqual((await call('/v1/chat-settings')).value.allowedTools,[]);
  const root=(await call('/v1/voice-replies')).value,request={source:'system',sessionId:root.sessionId,revision:root.revision};
  const pending=call('/v1/voice-replies/setup',request);await began;
  assert.equal((await call('/v1/voice-replies/setup',request)).value.error,'VOICE_REPLY_BUSY');
  assert.equal((await call('/v1/chat-settings',{...request,allowedTools:[]})).value.error,'VOICE_REPLY_BUSY');
  assert.equal(service.isIdle(),false);await assert.rejects(service.backup(),/VOICE_REPLY_BUSY/);
  const queued=await call('/v1/messages',{deviceId:'browser',clientMessageId:'synthetic-during-setup',text:'Synthetic pending request',queuedAt:Date.now(),expectedMode:'social',expectedModeRevision:boot.modeRevision});assert.equal(queued.status,200);
  await service.tick();assert.equal(replyCalls,0);
  release();assert.equal((await pending).status,200);await service.tick();assert.equal(replyCalls,1);
});

test('native snapshots preserve the voice choice and reject a configuration change during capture',async t=>{
  let cleanup;const box=sandbox({after:fn=>cleanup=fn}),previous=process.env.DSH_HOME;
  process.env.DSH_HOME=path.join(box.root,'synthetic-dsh');let snapshot,ledger;
  t.after(()=>{try{snapshot?.close();ledger?.close();}finally{if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;cleanup();}});
  const root=path.join(box.root,'bridge'),sessionsRoot=path.join(box.root,'sessions'),sessionId='synthetic-session';
  fs.mkdirSync(path.join(root,'plugins'),{recursive:true});fs.mkdirSync(path.join(root,'voice-replies'));
  const original=JSON.stringify({format:'chatagent-voice-replies-v1',source:'system',voice:'Synthetic Chinese'}),choice=path.join(root,'voice-replies/settings.json');fs.writeFileSync(choice,original);
  const session=path.join(sessionsRoot,'project',sessionId);fs.mkdirSync(session,{recursive:true});fs.writeFileSync(path.join(session,'session.v4.jsonl'),'Synthetic session');
  const module=path.join(box.root,'memory-fixture.mjs');fs.writeFileSync(module,"export const loadCfg=()=>({模式:'session'}),库名=()=> 'synthetic-memory',loadStore=()=>({memories:[]});");
  const diaries=new DatabaseSync(path.join(root,'plugins/plugins.sqlite'));diaries.exec('CREATE TABLE jobs(id TEXT)');diaries.close();
  ledger=new DatabaseSync(path.join(root,'requests.sqlite'));ledger.exec('CREATE TABLE requests(id TEXT)');
  snapshot=await nativeBackupSnapshot({config:{root,migrationOptions:{module:pathToFileURL(module).href}},sessionId,sessionsRoot,ledger});
  assert.equal(fs.readFileSync(path.join(snapshot.directory,'voice-replies/settings.json'),'utf8'),original);snapshot.check();
  fs.writeFileSync(choice,'changed');assert.throws(()=>snapshot.check(),/BACKUP_SOURCE_CHANGED/);
});

test('real Windows synthesis preserves Chinese text and produces a PCM WAV without playing audio',{skip:process.platform!=='win32'},async t=>{
  const voices=await runSystemVoice({action:'voices'});if(!voices.length){t.skip('No installed Chinese system voice');return;}
  const {root}=sandbox(t),voice=new VoiceReplies({root});t.after(()=>voice.close());
  await voice.setup({source:'system'});const sample=await voice.preview();
  assert.ok(sample.seconds>1&&sample.seconds<30);assert.ok(Buffer.from(sample.data,'base64').length>48000);assert.equal(voice.read().source,'system');
});
