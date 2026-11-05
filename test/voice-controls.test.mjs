import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {randomBytes} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';import {execFileSync} from 'node:child_process';
import {sandbox} from './helpers.mjs';import {startService} from '../apps/service/server.mjs';import {createAudioInput} from '../packages/dsh-adapter/audio-input.mjs';import {wav} from '../packages/companion-capabilities/media.mjs';import {verifyAttachmentSnapshot} from '../packages/storage/attachments.mjs';

test('语音时长无需播放即可同步；转文字需鉴权、一次入账、长音频分块覆盖完整且不产生对话',async t=>{
 let db,service,queue=Promise.resolve();t.after(async()=>{await queue;await service?.close();db?.close();});
 const {root}=sandbox(t);db=new DatabaseSync(path.join(root,'transcripts.sqlite'));let calls=0,modelCalls=0;const spans=[];
 const processor=createAudioInput({db,root,recognize:async args=>{calls++;spans.push([args.offsetSeconds,args.segmentSeconds]);return {text:'片段'+calls};}});
 const backend={attachDelivery:b=>processor.attach(b),attachmentTranscription:id=>processor.transcription(id),transcribeAttachment:id=>processor.requestTranscription(id,action=>{queue=queue.then(action);}),execute:()=>{modelCalls++;throw Error('NO_MODEL_EXPECTED');}};
 service=await startService({dataRoot:path.join(root,'chat'),devicePort:0,backend});
 const input=path.join(root,'long.wav');fs.writeFileSync(input,wav(Buffer.alloc(16000*2*125),16000));const row=service.attachments.importFile(input);
 const reference={id:row.id,name:row.name,sha256:row.sha256,bytes:row.bytes,mediaType:row.media_type};service.store.publish({deliveryId:'long-voice',text:'长音频测试',attachments:[reference]});
 const before=JSON.stringify(service.store.db.prepare('SELECT * FROM messages').all());const boot=await(await fetch(service.url+'/v1/bootstrap')).json(),admin={'X-Chatagent-Token':boot.token,'Content-Type':'application/json'};
 const messages=await(await fetch(service.url+'/v1/messages',{headers:admin})).json();assert.equal(messages[0].attachments[0].durationMs,125000);assert.equal(calls,0);
 const invite=await(await fetch(service.url+'/v1/pairing/invitations',{method:'POST',headers:admin,body:'{}'})).json();const token=randomBytes(32).toString('hex');
 const claim=await fetch(service.deviceUrl+'/v1/pairing/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({credential:invite.credential,deviceToken:token,name:'voice-controls-test'})});assert.equal(claim.status,200);
 const route='/v1/attachments/'+row.id+'/transcription',headers={Authorization:'Bearer '+token,'Content-Type':'application/json'};
 assert.equal((await fetch(service.deviceUrl+route,{method:'POST',body:'{}'})).status,401);
 assert.equal((await(await fetch(service.deviceUrl+route,{headers})).json()).state,'not-requested');assert.equal(calls,0);
 const start=await fetch(service.deviceUrl+route,{method:'POST',headers,body:'{}'});assert.equal(start.status,200);await queue;
 const result=await(await fetch(service.deviceUrl+route,{headers})).json();assert.equal(result.state,'completed');assert.equal(result.text,'片段1\n片段2');assert.deepEqual(spans,[[0,62.5],[62.5,62.5]]);
 await fetch(service.deviceUrl+route,{method:'POST',headers,body:'{}'});await queue;assert.equal(calls,2);assert.equal(modelCalls,0);assert.equal(JSON.stringify(service.store.db.prepare('SELECT * FROM messages').all()),before);
 const destination=path.join(root,'sealed-attachments');await service.attachments.checkpoint(destination);assert.equal(verifyAttachmentSnapshot(destination,[reference]).ready,1);const saved=new DatabaseSync(path.join(destination,'attachments.sqlite'),{readOnly:true});assert.equal(saved.prepare('SELECT duration_ms FROM audio_metadata').get().duration_ms,125000);saved.close();
});

test('按需转写中断保留unknown，静音失败不编造，重新查询与点击不自动重跑',async t=>{
 let db;t.after(()=>db?.close());const {root}=sandbox(t);db=new DatabaseSync(path.join(root,'ledger.sqlite'));let calls=0;const pending=[];
 let processor=createAudioInput({db,root,recognize:async()=>{calls++;return {text:'.'};}});const attach={attachments:{verify:()=>({sha256:'a'.repeat(64),file:path.join(root,'voice'),media_type:'audio/wav'}),audioDuration:()=>1000}};processor.attach(attach);
 assert.equal(processor.requestTranscription('a',action=>pending.push(action)).state,'queued');processor=createAudioInput({db,root,recognize:async()=>{calls++;throw Error('DO_NOT_REPLAY');}});processor.attach(attach);assert.equal(processor.requestTranscription('a',()=>{throw Error('DO_NOT_SCHEDULE');}).state,'unknown');assert.equal(calls,0);
 const other={attachments:{verify:()=>({sha256:'b'.repeat(64),file:path.join(root,'voice'),media_type:'audio/wav'}),audioDuration:()=>1000}};
 const silence=createAudioInput({db,root,recognize:async()=>{calls++;return {text:'.'};}});silence.attach(other);let job;silence.requestTranscription('b',action=>{job=action();});await job;assert.equal(silence.transcription('b').state,'failed');assert.equal(silence.transcription('b').text,null);silence.requestTranscription('b',()=>{throw Error('DO_NOT_SCHEDULE');});assert.equal(calls,1);
});

test('实际Java长按拖动：短按不定位，左右边界、长歌进度与取消',t=>{
 const {root}=sandbox(t),java=process.env.CHATAGENT_JDK??'C:/Program Files/Java/jdk-17';fs.writeFileSync(path.join(root,'SeekCheck.java'),`import local.chatagent.privatechat.VoiceSeekGesture;public class SeekCheck{static void check(boolean b){if(!b)throw new AssertionError();}public static void main(String[] args){VoiceSeekGesture g=new VoiceSeekGesture();g.begin(100,0,258000);g.move(200,200,8);check(!g.dragging()&&g.target()==0);g.arm();g.move(200,200,8);check(g.dragging()&&g.target()==129000);g.move(1000,200,8);check(g.target()==258000);g.move(-100,200,8);check(g.target()==0);g.cancel();check(!g.armed()&&!g.dragging());g.begin(100,80000,258000);g.arm();g.move(104,200,8);check(!g.dragging()&&g.target()==80000);System.out.println("seek gestures passed");}}`);
 execFileSync(path.join(java,'bin/javac.exe'),['-encoding','UTF-8','-d',root,path.resolve('apps/android/src/local/chatagent/privatechat/VoiceSeekGesture.java'),path.join(root,'SeekCheck.java')]);assert.match(execFileSync(path.join(java,'bin/java.exe'),['-cp',root,'SeekCheck'],{encoding:'utf8'}),/seek gestures passed/);
});
