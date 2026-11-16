import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {MediaConnections} from '../packages/dsh-bridge/media-connections.mjs';import {musicAudio} from '../packages/dsh-bridge/media-audio.mjs';import {sandbox} from './helpers.mjs';
const secrets={protect:v=>Buffer.from(v).toString('base64'),unprotect:v=>Buffer.from(v,'base64').toString()},hash=b=>createHash('sha256').update(b).digest('hex');
const audio=()=>{const data=Buffer.from('fLaCsynthetic-audio');return {data,mime:'audio/flac',sha256:hash(data)};};
function enable(c,{protocol='gemini',auth='key'}={}){const v=c.read();Object.assign(v.connections.music,{enabled:true,protocol,auth,model:'synthetic-audio-model',apiKey:auth==='key'?'synthetic-test-key':'',baseUrl:'https://audio.example/v1'});return c.save(v);}
test('media settings encrypt keys, reject endpoint credential carryover and protect concurrent edits',t=>{
 const {root}=sandbox(t),c=new MediaConnections(root,{secrets});const saved=enable(c);assert.equal(saved.connections.music.ready,true);assert.ok(!JSON.stringify(saved).includes('synthetic-test-key'));assert.ok(!fs.readFileSync(c.file,'utf8').includes('synthetic-test-key'));
 const changed=structuredClone(saved);changed.connections.music.baseUrl='https://other.example/v1';assert.throws(()=>c.save(changed),/MEDIA_ENDPOINT_KEY_REQUIRED/);assert.equal(c.read().revision,saved.revision);
 changed.connections.music.apiKey='new-test-key';c.save(changed);assert.throws(()=>c.save(saved),/MEDIA_CONFIG_CHANGED/);
 const retired=c.read();retired.connections.music.baseUrl='https://cloudcode-pa.googleapis.com';assert.throws(()=>c.save(retired),/MEDIA_RETIRED_ENDPOINT/);
 const cleared=c.read();Object.assign(cleared.connections.music,{enabled:false,clearKey:true});assert.equal(c.save(cleared).connections.music.hasKey,false);
});
test('missing audio configuration performs no network call or credential lookup',async t=>{
 const {root}=sandbox(t);let calls=0;const c=new MediaConnections(root,{secrets:{unprotect:()=>assert.fail('no key lookup')},fetchImpl:()=>calls++});await assert.rejects(c.infer('music',{prompt:'fixture',audio:audio()}),/MEDIA_NOT_CONFIGURED/);assert.equal(calls,0);
});
test('Gemini music sends original bytes with no persona/history and accepts only a complete text result',async t=>{
 const {root}=sandbox(t);let calls=0;const original=audio(),c=new MediaConnections(root,{secrets,fetchImpl:async(url,options)=>{
  calls++;assert.equal(url,'https://audio.example/v1/models/synthetic-audio-model:generateContent');assert.equal(options.redirect,'error');assert.equal(options.headers['x-goog-api-key'],'synthetic-test-key');const wire=JSON.parse(options.body);assert.deepEqual(Buffer.from(wire.contents[0].parts[1].inlineData.data,'base64'),original.data);assert.equal(wire.contents[0].parts[0].text,'fixture prompt');assert.equal(wire.contents.length,1);
  return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:'internal'},{text:'fixture observation'}]}}],usageMetadata:{promptTokensDetails:[{modality:'AUDIO',tokenCount:12}]}});
 }});enable(c);const report=await c.infer('music',{prompt:'fixture prompt',audio:original});assert.equal(calls,1);assert.equal(report.wireAudioVerified,true);assert.equal(report.wireAudioSha256,original.sha256);assert.equal(report.responseText,'fixture observation');assert.equal(report.audioReceipt,true);
});
test('authentication and incomplete returns stay failed, sanitized and never retry',async t=>{
 const {root}=sandbox(t);let calls=0,denied=true;const c=new MediaConnections(root,{secrets,fetchImpl:async()=>{calls++;return denied?new Response('synthetic-test-key',{status:403}):Response.json({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:'partial'}]}}]});}});enable(c);const report={};await assert.rejects(c.infer('music',{prompt:'fixture',audio:audio(),report}),/MEDIA_AUTH_FAILED/);assert.equal(calls,1);assert.equal(report.failure,'MEDIA_AUTH_FAILED');assert.ok(!JSON.stringify(report).includes('synthetic-test-key'));denied=false;await assert.rejects(c.infer('music',{prompt:'fixture',audio:audio()}),/MEDIA_RESPONSE_INCOMPLETE/);assert.equal(calls,2);
});
test('OpenAI audio requires actual WAV/MP3 rather than a relabeled FLAC',async t=>{
 const {root}=sandbox(t);let calls=0;const c=new MediaConnections(root,{secrets,fetchImpl:async(_,options)=>{calls++;const wire=JSON.parse(options.body);assert.equal(wire.messages[0].content[1].input_audio.format,'wav');return Response.json({choices:[{finish_reason:'stop',message:{content:'fixture'}}]});}});enable(c,{protocol:'chat-completions'});await assert.rejects(c.infer('music',{prompt:'fixture',audio:audio()}),/MEDIA_AUDIO_FORMAT_UNSUPPORTED/);assert.equal(calls,0);
 const data=Buffer.from('RIFFsynthetic-WAVE');await c.infer('music',{prompt:'fixture',audio:{data,mime:'audio/wav',sha256:hash(data)}});assert.equal(calls,1);
});
test('audio hash mismatch cannot be submitted',async t=>{const {root}=sandbox(t),c=new MediaConnections(root,{secrets,fetchImpl:()=>assert.fail('must not submit')});enable(c);await assert.rejects(c.infer('music',{prompt:'fixture',audio:{...audio(),sha256:'0'.repeat(64)}}),/MEDIA_AUDIO_INVALID/);});
test('Qwen 3.8 Omni uses an audio data URI and text-only output with thinking disabled',async t=>{
 const {root}=sandbox(t),data=Buffer.from('RIFFsynthetic-WAVE'),c=new MediaConnections(root,{secrets,fetchImpl:async(_,options)=>{
  const wire=JSON.parse(options.body),input=wire.messages[0].content[1].input_audio;
  assert.equal(input.data,'data:audio/wav;base64,'+data.toString('base64'));assert.equal(input.format,'wav');assert.deepEqual(wire.modalities,['text']);assert.equal(wire.reasoning_effort,'none');assert.equal(wire.stream,false);
  return Response.json({choices:[{finish_reason:'stop',message:{content:'fixture observation'}}],usage:{prompt_tokens_details:{audio_tokens:7}}});
 }});enable(c,{protocol:'chat-completions'});const config=c.read();config.connections.music.model='qwen3.8-omni-flash';c.save(config);
 const result=await c.infer('music',{prompt:'fixture',audio:{data,mime:'audio/wav',sha256:hash(data)}});assert.equal(result.audioReceipt,true);assert.equal(result.wireAudioSha256,hash(data));
});
test('configurable Gemini Live preserves raw-voice PCM, model, and audio usage evidence',async t=>{
 const {root}=sandbox(t),previous=globalThis.WebSocket,sent=[];let socketUrl;
 globalThis.WebSocket=class{constructor(url){socketUrl=url;this.events={};queueMicrotask(()=>this.events.open());}addEventListener(name,fn){this.events[name]=fn;}send(text){const v=JSON.parse(text);sent.push(v);if(v.setup)queueMicrotask(()=>this.events.message({data:JSON.stringify({setupComplete:{}})}));if(v.realtimeInput?.activityEnd)queueMicrotask(()=>this.events.message({data:JSON.stringify({usageMetadata:{promptTokensDetails:[{modality:'AUDIO',tokenCount:5}]},serverContent:{inputTranscription:{text:'fixture transcript'},outputTranscription:{text:'fixture transcript'},turnComplete:true}})}));}close(){}};
 t.after(()=>globalThis.WebSocket=previous);const c=new MediaConnections(root,{secrets}),v=c.read();Object.assign(v.connections.hearing,{enabled:true,protocol:'gemini-live',baseUrl:'https://live.example',model:'synthetic-live',apiKey:'synthetic-key'});c.save(v);
 const data=Buffer.alloc(46);data.write('RIFF');data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.write('data',36);data.writeUInt32LE(2,40);data.writeInt16LE(1234,44);
 const report=await c.infer('hearing',{prompt:'fixture',audio:{data,mime:'audio/wav',sha256:hash(data)}});assert.equal(report.audioReceipt,true);assert.equal(report.inputTranscript,'fixture transcript');assert.equal(sent[0].setup.model,'models/synthetic-live');assert.equal(new URL(socketUrl).hostname,'live.example');const raw=sent.find(v=>v.realtimeInput?.audio);assert.deepEqual(Buffer.from(raw.realtimeInput.audio.data,'base64'),data.subarray(44));
});
