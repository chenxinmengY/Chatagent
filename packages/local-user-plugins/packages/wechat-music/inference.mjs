import {randomUUID,createHash} from 'node:crypto';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
import {summarizeRejection} from './error-summary.mjs';
export const hash=b=>createHash('sha256').update(b).digest('hex');
const req=createRequire('D:/dsh/resources/app/dsh/probe.cjs');
const {createUserMessage}=await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-llm')).href);
export function buildWire(codec,credential,prompt,audio,sessionId='isolated-whole-song-'+randomUUID()){
 if(typeof prompt!=='string'||prompt.length>50000||!sessionId.startsWith('isolated-whole-song-'))throw Error('ISOLATED_SCOPE');
 const mime=audio?.mime??'audio/flac';
 if(audio&&(!Buffer.isBuffer(audio.data)||audio.data.length>8*1024*1024||
  !(mime==='audio/flac'&&audio.data.toString('ascii',0,4)==='fLaC'||mime==='audio/mp3'&&audio.data.toString('ascii',0,3)==='ID3')||
  hash(audio.data)!==audio.sha256||!(audio.seconds>0&&audio.seconds<=300)))throw Error('AUDIO_BINDING');
 const marker='ISOLATED_AUDIO_'+randomUUID(),messages=[createUserMessage({content:[{type:'text',text:prompt},...(audio?[{type:'text',text:marker}]:[])],source:{kind:'synthetic-test'}})];
 const options={provider:'antigravity',model:'gemini-3.8-flash',sessionId,messages,tools:[],maxTokens:6144,temperature:0,reasoningEffort:'medium'};
 const wire=codec.buildRequest(options,codec.model,credential.projectId,'gemini-3.8-flash-tiered',codec.resolveReasoning(codec.model,'medium'),new Map());
 if(wire.model!=='gemini-3.8-flash-tiered'||wire.request.tools||wire.request.sessionId!==sessionId)throw Error('MODEL_OR_SCOPE_CHANGED');
 wire.request.toolConfig={functionCallingConfig:{mode:'NONE'}};
 if(audio){let n=0;for(const c of wire.request.contents)for(const p of c.parts??[])if(p.text===marker){delete p.text;p.inlineData={mimeType:mime,data:audio.data.toString('base64')};n++;}
  const parts=wire.request.contents.flatMap(c=>c.parts??[]).filter(p=>p.inlineData);if(n!==1||parts.length!==1||hash(Buffer.from(parts[0].inlineData.data,'base64'))!==audio.sha256)throw Error('WIRE_AUDIO_MISMATCH');}
 if(Buffer.byteLength(JSON.stringify(wire))>12*1024*1024)throw Error('WIRE_SIZE');return wire;
}
function bounded(response,signal){const reader=response.body.getReader();let bytes=0;
 return new Response(new ReadableStream({async pull(c){try{signal.throwIfAborted();const p=await reader.read();signal.throwIfAborted();if(p.done){reader.releaseLock();c.close();return;}bytes+=p.value.length;if(bytes>512*1024)throw Error('RESPONSE_SIZE');c.enqueue(p.value);}catch(e){await reader.cancel().catch(()=>{});c.error(e);}},cancel:r=>reader.cancel(r)}));}
export async function infer({codec,credential,prompt,audio,report,fetcher=fetch,signal:callerSignal}){
 const wire=buildWire(codec,credential,prompt,audio),body=JSON.stringify(wire),state=codec.createStreamState(),start=performance.now();let response,text='';
 report.wireSha256=hash(Buffer.from(body));report.wireBytes=Buffer.byteLength(body);report.wireAudioVerified=!!audio;report.runtimeModel=wire.model;
 const signal=callerSignal?AbortSignal.any([callerSignal,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000);try{
  signal.throwIfAborted();
  report.networkCalls=1;response=await fetcher('https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse',{
   method:'POST',headers:codec.antigravityHeaders(credential.token),body,signal,redirect:'error'});report.httpStatus=response.status;report.headersMs=Math.round(performance.now()-start);
  if(!response.ok){report.rejection=(await summarizeRejection(response,credential)).summary;report.status='unavailable';return;}
  for await(const c of codec.streamResponseToChunks(bounded(response,signal),codec.model,wire.model,state)){
   if(c.type==='text-delta')text+=c.text??'';if(text.length>24000)throw Error('OUTPUT_SIZE');
   if(c.type==='tool-call-delta')throw Error('UNEXPECTED_TOOL');
  }
  report.nativeStop=state.finishReason==='STOP';report.status=report.nativeStop&&text.trim()?'unverified_observation':'incomplete';
 }catch(e){report.status='unavailable';report.error='ISOLATED_RESPONSE_UNCONFIRMED';report.transportFailure={name:/^[A-Za-z]{1,30}$/.test(e?.name??'')?e.name:'Error',code:/^[A-Z0-9_]{1,80}$/.test(e?.cause?.code??e?.code??'')?(e.cause?.code??e.code):undefined};}
 finally{report.elapsedMs=Math.round(performance.now()-start);report.responseText=text;report.finishReason=state.finishReason;report.usage=state.usage;
  report.audioReceipt=state.usage?.promptTokensDetails?.some(d=>d.modality==='AUDIO'&&d.tokenCount>0)===true;await response?.body?.cancel().catch(()=>{});}
}
