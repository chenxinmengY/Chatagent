import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {sandbox} from './helpers.mjs';
import {PortableAsr,downloadAsrAsset,extractAsrArchives} from '../packages/companion-capabilities/portable-asr.mjs';
import {BasicSpeech} from '../packages/companion-capabilities/basic-speech.mjs';
import {VoiceReplies} from '../packages/companion-capabilities/system-voice.mjs';
import {verifyAsrInstallation} from '../packages/companion-capabilities/isolated-asr.mjs';
import {wav,verifyAudio} from '../packages/companion-capabilities/media.mjs';
import {startService} from '../apps/service/server.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const asset=(name,body,target)=>({id:name,kind:'file',url:'https://synthetic.invalid/'+name,bytes:Buffer.byteLength(body),sha256:digest(body),target});
function tinyInstaller(root,options={}){
  const bodies=['synthetic-model','synthetic-tokens'],calls=[];
  const catalog={recipe:'synthetic-verified-asr',files:[asset('model',bodies[0],'model/model.int8.onnx'),asset('tokens',bodies[1],'model/tokens.txt')]};
  const installer=new PortableAsr({root:path.join(root,'runtime'),catalog,platform:'win32',arch:'x64',
    fetchImpl:async url=>{calls.push(url);return new Response(bodies[url.endsWith('/model')?0:1]);},
    extract:async({root})=>{fs.mkdirSync(path.join(root,'env/Scripts'),{recursive:true});fs.writeFileSync(path.join(root,'env/Scripts/python.exe'),'synthetic-python');fs.writeFileSync(path.join(root,'ffmpeg.exe'),'synthetic-ffmpeg');},...options});
  return {installer,catalog,calls};
}
function basicFixture(root,options={}){
  const legacy={synthesize:async()=>({old:true}),close:async()=>{}};
  const voice=new VoiceReplies({root,legacy,platform:'win32',run:async request=>{
    if(request.action==='voices')return [{name:'Synthetic Chinese',culture:'zh-CN'}];
    fs.writeFileSync(request.file,wav(Buffer.alloc(48000)));return {completed:true};
  }});
  const f=tinyInstaller(root);
  const speech=new BasicSpeech({voice,root,installer:f.installer,recognizer:()=>async({directory})=>{fs.writeFileSync(path.join(directory,'input.wav'),'synthetic-conversion');return {text:'你好，语音准备好了。'};},...options});
  return {...f,voice,speech};
}

test('download rejects corrupt, truncated and oversized packages, cleans partial files and reuses only a verified cache',async t=>{
  const {root}=sandbox(t),cache=path.join(root,'cache');fs.mkdirSync(cache);
  const item=asset('download','abc','unused');
  for(const body of ['a','xyz','abcd']){
    await assert.rejects(downloadAsrAsset(item,cache,{fetchImpl:async()=>new Response(body)}),/ASR_SETUP_DOWNLOAD_(HASH|SIZE)/);
    assert.deepEqual(fs.readdirSync(cache),[]);
  }
  await assert.rejects(downloadAsrAsset(item,cache,{fetchImpl:async()=>{throw Error('synthetic network failure');}}),/DOWNLOAD_FAILED/);
  const controller=new AbortController();
  await assert.rejects(downloadAsrAsset(item,cache,{signal:controller.signal,fetchImpl:async()=>new Response('abc'),progress:()=>controller.abort()}),/CANCELLED/);
  assert.deepEqual(fs.readdirSync(cache),[]);
  const file=await downloadAsrAsset(item,cache,{fetchImpl:async()=>new Response('abc')});
  assert.equal(await downloadAsrAsset(item,cache,{fetchImpl:()=>{throw Error('must not download');}}),file);
  fs.writeFileSync(file,'bad');
  await downloadAsrAsset(item,cache,{fetchImpl:async()=>new Response('abc')});assert.equal(fs.readFileSync(file,'utf8'),'abc');
});

test('failed recognition cannot publish a package, and retry reuses downloads before verifying and publishing',async t=>{
  const {root}=sandbox(t),{installer,calls}=tinyInstaller(root);
  await assert.rejects(installer.ensure({probe:async()=>{throw Error('ASR_SETUP_TEST_FAILED');}}),/TEST_FAILED/);
  assert.equal(fs.existsSync(installer.directory),false);assert.equal(installer.read().stage,'failed');
  assert.ok(!fs.readdirSync(installer.root).some(name=>name.startsWith('.staging-')));
  await installer.ensure({probe:async root=>{assert.equal(verifyAsrInstallation(root).completed,true);}});
  assert.equal(calls.length,2);assert.equal(installer.read().stage,'ready');assert.equal(installer.read().busy,false);
  fs.writeFileSync(path.join(installer.directory,'model/model.int8.onnx'),'changed');
  await installer.ensure({probe:async()=>{}});assert.equal(calls.length,2);
  assert.ok(fs.readdirSync(installer.root).some(name=>name.startsWith('damaged-')));verifyAsrInstallation(installer.directory);
});

test('shared installers download once, while a user-owned runtime directory is preserved',async t=>{
  const {root}=sandbox(t),f=tinyInstaller(root);let probes=0;
  const second=tinyInstaller(root).installer;
  await Promise.all([f.installer.ensure({probe:async()=>{probes++;}}),second.ensure({probe:async()=>{probes++;}})]);
  assert.equal(f.calls.length,2);assert.equal(probes,1);assert.equal(second.read().stage,'ready');
  const foreign=path.join(root,'foreign');fs.mkdirSync(foreign);fs.writeFileSync(path.join(foreign,'keep.txt'),'user data');
  const installer=new PortableAsr({root:foreign,platform:'win32',arch:'x64'});
  await assert.rejects(installer.ensure({probe:async()=>{}}),/FOREIGN_DIRECTORY/);
  assert.deepEqual(fs.readdirSync(foreign),['keep.txt']);assert.equal(fs.readFileSync(path.join(foreign,'keep.txt'),'utf8'),'user data');
});

test('one click persists transcription and free replies together; restart and restoring the AI voice retain transcription',async t=>{
  const {root}=sandbox(t),f=basicFixture(root);t.after(()=>f.speech.close());
  assert.equal(f.speech.read().asr.ready,false);assert.equal(f.voice.read().source,'existing');
  const ready=await f.speech.setup({source:'system'});assert.equal(ready.asr.ready,true);assert.equal(ready.source,'system');
  assert.deepEqual(fs.readdirSync(f.voice.root),['settings.json']);
  const reopened=new BasicSpeech({root,voice:f.voice,installer:f.installer});assert.equal(reopened.read().asr.ready,true);
  await f.speech.setup({source:'existing'});assert.equal(f.speech.read().asr.ready,true);assert.equal(f.voice.read().source,'existing');
  assert.equal((await f.voice.synthesize({})).old,true);
});

test('existing transcription is probed and reused without downloading; failed setup preserves saved settings',async t=>{
  const {root}=sandbox(t),f=basicFixture(root);t.after(()=>f.speech.close());
  await f.installer.ensure({probe:async()=>{}});
  const speech=new BasicSpeech({root,voice:f.voice,asrRoot:f.installer.directory,installer:{read:()=>({busy:false}),ensure:()=>{throw Error('must not install');}},recognizer:()=>async()=>({text:'已有转写可以使用。'})});
  await speech.setup({source:'system'});assert.equal(f.voice.settings().transcription.source,'existing');
  const previous=fs.readFileSync(f.voice.file,'utf8');
  const broken=new BasicSpeech({root,voice:f.voice,asrRoot:f.installer.directory,installer:f.installer,recognizer:()=>async()=>({text:'。！？'})});
  await assert.rejects(broken.setup({source:'system'}),/TEST_FAILED/);assert.equal(fs.readFileSync(f.voice.file,'utf8'),previous);
  assert.deepEqual(fs.readdirSync(f.voice.root),['settings.json']);
});

test('failed combined setup does not grant voice tools or change the existing chat permissions',async t=>{
  let cleanup;const box=sandbox({after:fn=>cleanup=fn}),f=basicFixture(box.root,{recognizer:()=>async()=>{throw Error('ASR_PROCESS_FAILED');}});
  const backend={kind:'synthetic-basic-speech',status:()=>({modeBindings:[{mode:'social',session_id:'synthetic'}]}),voiceReplies:()=>f.speech.read(),setupVoiceReplies:body=>f.speech.setup(body),previewVoiceReplies:()=>f.speech.preview(),reply:async()=>''};
  const service=await startService({dataRoot:path.join(box.root,'chat'),backend,allowChatSpaces:false});
  t.after(async()=>{await service.close();await f.speech.close();cleanup();});
  const boot=await(await fetch(service.url+'/v1/bootstrap')).json(),headers={'X-Chatagent-Token':boot.token,'Content-Type':'application/json'};
  const initial=await(await fetch(service.url+'/v1/voice-replies',{headers})).json();
  const response=await fetch(service.url+'/v1/voice-replies/setup',{method:'POST',headers,body:JSON.stringify({source:'system',sessionId:initial.sessionId,revision:initial.revision})});
  assert.equal(response.status,409);assert.equal((await response.json()).error,'ASR_SETUP_TEST_FAILED');
  const after=await(await fetch(service.url+'/v1/voice-replies',{headers})).json();
  assert.deepEqual(after.allowedTools,initial.allowedTools);assert.equal(after.revision,initial.revision);assert.equal(after.source,'existing');assert.equal(after.asr.ready,false);assert.equal(fs.existsSync(f.voice.file),false);
});

test('free voice PCM delivery requires no external audio commands and still rejects changed or malformed audio',async t=>{
  const {root}=sandbox(t),file=path.join(root,'reply.wav');const bytes=wav(Buffer.alloc(48000));fs.writeFileSync(file,bytes);
  const options={ffmpeg:'synthetic-no-ffmpeg',ffprobe:'synthetic-no-ffprobe',expectedHash:digest(bytes)};
  assert.equal((await verifyAudio(file,options)).seconds,1);
  await assert.rejects(verifyAudio(file,{...options,expectedHash:'0'.repeat(64)}),/AUDIO_CHANGED/);
  await assert.rejects(verifyAudio(file,{...options,maxSeconds:0.5}),/AUDIO_FORMAT/);
  const invalid=Buffer.concat([bytes,Buffer.from('broken chunk')]);invalid.writeUInt32LE(invalid.length-8,4);fs.writeFileSync(file,invalid);
  await assert.rejects(verifyAudio(file,{...options,expectedHash:digest(invalid)}),/AUDIO_FORMAT/);
});

// Small, stored ZIP fixture. The real Windows extractor must reject an archive
// path before creating any file outside its staging directory.
function storedZip(name){
  const n=Buffer.from(name),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(n.length,26);
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(n.length,28);
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+n.length,12);end.writeUInt32LE(local.length+n.length,16);
  return Buffer.concat([local,n,central,n,end]);
}
test('the real archive extractor refuses traversal and Windows absolute paths',{skip:process.platform!=='win32'},async t=>{
  const {root}=sandbox(t);
  for(const [i,name]of ['../escape.txt','C:/escape.txt','safe\\escape.txt'].entries()){
    const stage=path.join(root,'stage'+i),file=path.join(root,'bad'+i+'.zip');fs.mkdirSync(stage);fs.writeFileSync(file,storedZip(name));
    await assert.rejects(extractAsrArchives({root:stage,archives:[{kind:'python',file}]}),/EXTRACT_FAILED/);assert.deepEqual(fs.readdirSync(stage),[]);
  }
  assert.equal(fs.existsSync(path.join(root,'escape.txt')),false);
});
