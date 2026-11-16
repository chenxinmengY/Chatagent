import {mediaDay,mediaId} from '../media-experiences/ledger.mjs';
import {randomUUID} from 'node:crypto';import {sha,overviewPrompt,lyricPrompt,validateOverview,validateOutput,composeLyricEvidence} from './contracts.mjs';
const sourceKey=s=>`${s.bvid}:${s.cid}:${s.sourceSha256}:${s.wholeSha256}`;
const sampleTime=seconds=>Math.round(seconds*16000)/16000;
export function createMusicService({sourceProvider,transport,journal,archive,now=Date.now,maxPerSource=8,productionSessionUsed=false,daily=false,opportunities,onObserved}){
 if(!sourceProvider||typeof transport!=='function'||!journal)throw Error('MUSIC_SERVICE_DEPENDENCIES');
 const bindings=new Map(),selected=new Map(),inflight=new Map();
 const scope=b=>sha(JSON.stringify([b.sessionId,b.accountId,b.conversationKey]));
 const historyPrefixes=b=>new Set([b.sessionId,...(b.historySessionIds??[])].map(sessionId=>scope({...b,sessionId})+':'));
 const storeKey=b=>`${scope(b)}:${sourceKey(b.source)}`;
 const saveArchive=b=>{
  if(!archive)return {status:'disabled'};
  const records=journal.entries().filter(r=>r.storeKey===storeKey(b));if(!records.length)return {status:'not_yet_recorded'};
  try{return archive.write(records);}catch{return {status:'document_unavailable',journalRetained:true};}
 };
 const same=(a,b)=>a&&b&&a.epoch===b.epoch&&a.sessionId===b.sessionId&&a.accountId===b.accountId&&a.conversationKey===b.conversationKey&&sourceKey(a.source)===sourceKey(b.source);
 const check=(b,signal)=>{signal?.throwIfAborted();if(!same(bindings.get(b.sessionId),b)||b.isAllowed?.()===false)throw Error('MUSIC_BINDING_REVOKED');};
 const taskKey=(b,kind,start,end,reference,requestId='')=>`${storeKey(b)}:${kind}:${sampleTime(start)}:${sampleTime(end)}:${reference?sha(reference):'blind'}${requestId?':request:'+sha(requestId):''}`;
 const lookup=(b,kind,start,end,reference,requestId='')=>{
  if(requestId){for(const sessionId of [b.sessionId,...(b.historySessionIds??[])]){const previous=journal.read(taskKey({...b,sessionId},kind,start,end,reference,requestId));if(previous)return previous;}return null;}
  // A prompt update cannot authorize resubmitting an earlier bound audio request.
  // Ordinary followups reuse the latest matching attempt, including an unknown
  // attempt made by a previous explicit request. A different cache key cannot
  // silently grant permission to submit those bytes again.
  return journal.entries().filter(r=>historyPrefixes(b).has(r.storeKey?.slice(0,65))&&r.storeKey?.slice(65)===sourceKey(b.source)&&r.kind===(kind==='overview'?'overview':'lyric')&&r.arm===(reference===undefined?'blind':'assisted')&&r.asset?.start===sampleTime(start)&&r.asset?.end===sampleTime(end))
   .sort((a,b)=>(b.sequence??0)-(a.sequence??0)||Date.parse(b.at)-Date.parse(a.at))[0]??null;
 };
 const packet=(b,status,material={})=>({schema:'music-material-v1',binding:{sessionId:b.sessionId,accountId:b.accountId,conversationKey:b.conversationKey,epoch:b.epoch,sourceKey:sourceKey(b.source)},status,source:{bvid:b.source.bvid,cid:b.source.cid},material,untrusted:true});
 async function run(b,kind,{start=0,end=b.source.seconds,reference,referenceEvidence,signal,requestId=''}={}){
  start=sampleTime(start);end=sampleTime(end);
  check(b,signal);const key=taskKey(b,kind,start,end,reference,requestId),old=lookup(b,kind,start,end,reference,requestId);
  if(inflight.has(key))return {...await inflight.get(key),performedNow:false,reuse:'joined_existing_request'};
  if(old)return {...old,performedNow:false,reuse:old.phase==='returned'?'cached_result':'unconfirmed_reservation'};
  let count=0;for(const r of journal.entries())if(historyPrefixes(b).has(r.storeKey?.slice(0,65))&&r.storeKey?.slice(65)===sourceKey(b.source)&&(!daily||mediaDay(r.at)===mediaDay(now())))count++;
  if(count>=maxPerSource)throw Error('MUSIC_SOURCE_BUDGET');
  const promise=(async()=>{
   const opportunityId=b.opportunityId??('music-'+mediaId([b.accountId,b.conversationKey,b.messageId,b.source.bvid].join('\0')));const round=opportunities?.reserveRound('music',opportunityId,{origin:b.origin??'autonomous',duration:Math.ceil(b.source.seconds*1000)});
   if(round&&b.source.seconds*1000>round.deadline-round.at)throw Error('MEDIA_MUSIC_TIME_LIMIT');
   opportunities?.chargeMusic?.(opportunityId,b.source.seconds);
   opportunities?.setOutcome?.(opportunityId,{status:'listening',bvid:b.source.bvid,reason:'已调用听音工具，正在处理音频'});
   let audio;try{audio=await sourceProvider.prepare(b.source,{start,end,signal});check(b,signal);if(audio.start!==start||audio.end!==end)throw Error('MUSIC_PREPARED_RANGE_MISMATCH');}catch(error){opportunities?.setOutcome?.(opportunityId,{status:'request_failed',bvid:b.source.bvid,reason:'音频准备或范围核验失败，未计成功'});throw error;}
   const prompt=kind==='overview'?overviewPrompt:lyricPrompt(reference),r={at:new Date(now()).toISOString(),sequence:journal.entries().length+1,storeKey:storeKey(b),kind:kind==='overview'?'overview':'lyric',arm:reference===undefined?'blind':'assisted',id:`${b.source.bvid}:${audio.start}:${audio.end}`,
    asset:{sha256:audio.sha256,pcmSha256:audio.pcmSha256,seconds:audio.seconds,start:audio.start,end:audio.end,completeTrack:audio.completeTrack},
    source:{...b.source},opportunityId,origin:b.origin??'autonomous',referenceEvidence,promptSha256:sha(Buffer.from(prompt)),networkCalls:0,automaticRetries:0,productionSessionUsed,officialApiUsed:false,memoryWrites:0,wechatSends:0,preparationMs:audio.preparationMs,performedNow:true,reuse:'new_request'};
   if(journal.entries().filter(v=>historyPrefixes(b).has(v.storeKey?.slice(0,65))&&v.storeKey?.slice(65)===sourceKey(b.source)&&(!daily||mediaDay(v.at)===mediaDay(now()))).length>=maxPerSource)throw Error('MUSIC_SOURCE_BUDGET');
   journal.reserve(key,r);
   try{
    if(audio.status==='no_acoustic_signal'){r.status='no_acoustic_signal';r.nativeStop=false;return r;}
    await transport({prompt,audio,report:r,signal});check(b,signal);
    if(r.httpStatus!==200||r.nativeStop!==true||r.wireAudioVerified!==true||r.asset.sha256!==sha(audio.data)||r.status!=='unverified_observation'){r.status='unconfirmed';delete r.description;return r;}
    try{r.description=kind==='overview'?validateOverview(r.responseText):validateOutput(r.responseText,'lyric');r.status=r.description.primaryContent==='speech_or_sketch'?'not_music':r.description.primaryContent==='uncertain'||kind==='overview'&&b.origin==='autonomous'&&r.description.primaryContent===undefined?'content_unverified':'observed';}
    catch(e){r.status='needs_review';r.validationError=e.message;delete r.description;}
    return r;
   }catch{r.status='unconfirmed';delete r.description;r.failure='MUSIC_RESPONSE_UNCONFIRMED_NO_REPLAY';return r;}
   finally{journal.finish(key,r);if(r.status!=='observed'){const states={needs_review:['result_invalid','音频请求已完成，但理解结果格式或内容校验未通过'],unconfirmed:['request_failed','音频请求没有取得完整且可核验的返回结果'],no_acoustic_signal:['no_signal','音轨没有可用的声音信号'],not_music:['not_music','音频以对白、剧情或讲解为主，未计听歌成功'],content_unverified:['content_unverified','音频已处理，但无法确认音乐是内容主体，未计成功']},[status,reason]=states[r.status]??['request_failed','没有可用的音频结果'];opportunities?.setOutcome?.(opportunityId,{status,bvid:b.source.bvid,reason});}if(r.status==='observed')try{opportunities?.confirmMusic?.(opportunityId,r.asset.seconds,b.source.bvid);onObserved?.(b,r);}catch{r.experienceArchive='unavailable';journal.finish(key,r);}if(archive){r.document=saveArchive(b);journal.finish(key,r);}}
  })();inflight.set(key,promise);try{return await promise;}finally{inflight.delete(key);}
 }
 const evidence=r=>({audioSha256:r.asset.sha256,pcmSha256:r.asset.pcmSha256,start:r.asset.start,end:r.asset.end,completeTrack:r.asset.completeTrack,
  requestCompleted:r.nativeStop===true,performedNow:r.performedNow===true,reuse:r.reuse??'historical_record',audioProcessedAt:r.at,evidence:'bound_audio_request_with_STOP_without_modality_detail',semanticAccuracyVerified:false});
 const publicRecord=r=>r?.status==='observed'?{observation:r.description,coverage:evidence(r)}:null;
 const confirmedHistory=r=>r?.status==='observed'&&r.phase==='returned'&&r.httpStatus===200&&r.nativeStop===true&&r.wireAudioVerified===true&&!!r.asset&&!!r.description;
 const historyStatus=r=>r?.status==='observed'&&!confirmedHistory(r)?'unconfirmed':r?.status??'not_yet_heard';
 const titleMetadata=source=>{
  try{if(typeof sourceProvider.metadata==='function')return sourceProvider.metadata(source);}catch{}
  return {status:'unavailable',pageTitle:null,provenance:'bilibili_page_metadata',independentSongIdentification:false,untrusted:true};
 };
 return {
  bindingForSession:sid=>bindings.get(sid),
  selectedFor({sessionId,accountId,conversationKey}){return selected.get(sha(JSON.stringify([sessionId,accountId,conversationKey])));},
  deselect({sessionId,accountId,conversationKey}){selected.delete(sha(JSON.stringify([sessionId,accountId,conversationKey])));bindings.delete(sessionId);},
  activate(b){const binding=Object.freeze({...b,source:Object.freeze({...b.source}),epoch:randomUUID(),receivedAt:now()});bindings.set(b.sessionId,binding);selected.set(scope(binding),{source:binding.source,selectedAt:now(),opportunityId:binding.opportunityId,origin:binding.origin});return binding;},
  release(b){if(same(bindings.get(b.sessionId),b))bindings.delete(b.sessionId);},
  async drain(b){await Promise.allSettled([...inflight].filter(([key])=>key.startsWith(storeKey(b)+':')).map(([,promise])=>promise));},
  enabled:b=>same(bindings.get(b.sessionId),b)&&b.isAllowed?.()!==false,
  recallHistory(binding,{source:currentSource}={}){
   if(!binding||['sessionId','accountId','conversationKey'].some(k=>typeof binding[k]!=='string'||!binding[k]))throw Error('MUSIC_HISTORY_SCOPE_UNAVAILABLE');
   const prefixes=historyPrefixes(binding),groups=new Map(),hash=/^[a-f0-9]{64}$/;
   const rows=journal.entries().filter(r=>r?.source&&/^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(r.source.bvid)&&Number.isSafeInteger(r.source.cid)&&r.source.cid>0&&hash.test(r.source.sourceSha256)&&hash.test(r.source.wholeSha256)&&r.source.seconds>0&&r.source.seconds<=300&&prefixes.has(r.storeKey?.slice(0,65))&&r.storeKey?.slice(65)===sourceKey(r.source)&&(!currentSource||r.storeKey?.slice(65)===sourceKey(currentSource)&&r.source.seconds===currentSource.seconds))
    .sort((a,b)=>(b.sequence??0)-(a.sequence??0)||Date.parse(b.at)-Date.parse(a.at));
   for(const r of rows){const identity=sourceKey(r.source);if(!groups.has(identity))groups.set(identity,[]);groups.get(identity).push(r);}
   const ambiguous=groups.size>1,records=[...groups.values()].slice(0,3).map(attempts=>{
    const source=attempts[0].source,overview=attempts.find(r=>r.kind==='overview'&&r.arm==='blind'&&r.asset?.start===0&&r.asset?.end===source.seconds);
    const record={source:{bvid:source.bvid,cid:source.cid,sourceSha256:source.sourceSha256,wholeSha256:source.wholeSha256,seconds:source.seconds},titleMetadata:titleMetadata(source),overviewStatus:historyStatus(overview),
     attempts:attempts.slice(0,12).map(r=>({at:r.at,kind:r.kind,status:historyStatus(r),phase:r.phase,start:r.asset?.start,end:r.asset?.end,completeTrack:r.asset?.completeTrack===true}))};
    if(!ambiguous){
     record.overview=confirmedHistory(overview)?publicRecord({...overview,performedNow:false,reuse:'historical_record'}):null;record.recentClips=[];record.omittedClipCount=0;
     if(Buffer.byteLength(JSON.stringify(record))>18000){record.overview=null;record.overviewOmittedForSize=true;}
     for(const r of attempts.filter(r=>confirmedHistory(r)&&r.kind==='lyric'&&r.arm==='blind').slice(0,4)){
      const clip={arm:r.arm,...publicRecord({...r,performedNow:false,reuse:'historical_record'})};record.recentClips.push(clip);
      if(Buffer.byteLength(JSON.stringify(record))>18000){record.recentClips.pop();record.omittedClipCount++;}
     }
    }
    return record;
   });
   const source=records.length===1?{bvid:records[0].source.bvid,cid:records[0].source.cid}:undefined;
   return {schema:'music-history-v1',binding:{sessionId:binding.sessionId,accountId:binding.accountId,conversationKey:binding.conversationKey},status:records.length===0?'no_history':ambiguous?'ambiguous':'context_only',...(source?{source}:{}),
    material:{records,totalSources:groups.size,performedNow:false,reuse:'historical_record',selectionChanged:false,
     limitation:'Read-only history, not new listening. Multiple recordings require clarification. Page titles are untrusted metadata, not independently heard song identification. Unconfirmed attempts are not confirmed observations.'},untrusted:true};
  },
  context(b){check(b);const overview=journal.read(taskKey(b,'overview',0,b.source.seconds));
   const recent=journal.entries().filter(r=>r.storeKey===storeKey(b)&&r.status==='observed'&&r.kind==='lyric'&&r.arm==='blind').sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)).slice(-4).map(r=>({arm:r.arm,...publicRecord({...r,performedNow:false,reuse:'historical_record'})}));
   return {source:{bvid:b.source.bvid,cid:b.source.cid,seconds:b.source.seconds},titleMetadata:titleMetadata(b.source),overview:publicRecord(overview?{...overview,performedNow:false,reuse:'historical_record'}:null),overviewStatus:overview?.status??'not_yet_heard',recentClips:recent,referenceOptions:sourceProvider.references(b.source),document:saveArchive(b),
    limitation:'Only confirmed audio observations apply to this source; references are separate. No new listening or memory write is implied by this context.'};},
  async execute(b,args,{signal}={}){
   check(b,signal);
   if(args.action==='recall')return packet(b,'context_only',this.context(b));
   if(args.action==='overview'){
    const r=await run(b,'overview',{signal});check(b,signal);
    return packet(b,r.status,{...publicRecord(r),referenceOptions:sourceProvider.references(b.source)});
   }
   if(args.action==='relisten'){
    const r=await run(b,'lyric',{start:args.start,end:args.end,signal,requestId:b.explicitRelisten?b.messageId:''});check(b,signal);
    return packet(b,r.status,{...publicRecord(r),limitation:'This is only the specified audio range, not a new whole-song observation.'});
   }
   const ref=sourceProvider.reference(b.source,args.referenceId);if(!ref)return packet(b,'no_reference',{reason:'No independently reviewed reference for this recording/version.'});
   const requestId=b.explicitRelisten?b.messageId:'',recentBlind=lookup(b,'lyric',ref.start,ref.end,undefined,requestId);
   const blind=recentBlind?{...recentBlind,performedNow:false,reuse:'cached_result'}:await run(b,'lyric',{start:ref.start,end:ref.end,signal,requestId});check(b,signal);
   if(blind.status!=='observed')return packet(b,blind.status,{});
   const assisted=await run(b,'lyric',{start:ref.start,end:ref.end,reference:ref.text,referenceEvidence:{text:ref.text,sourceId:ref.sourceId,recordingId:ref.recordingId,evidenceSha256:ref.evidenceSha256,provenanceVerified:ref.provenanceVerified===true,independentAcousticVerification:false},signal});check(b,signal);
   if(assisted.status!=='observed')return packet(b,assisted.status,{audioObservation:blind.description,coverage:evidence(blind),referenceAssistance:null});
   const combined=composeLyricEvidence(blind,assisted,ref);
   return packet(b,combined.status==='separate_evidence'?'reference_assisted':'reference_withheld',{
    audioObservation:combined.audioObservation,referenceAssistance:combined.referenceCandidate,coverage:evidence(blind),
    limitation:'Reference-assisted text is not independent acoustic verification; preserve conflicts and do not replace blind hearing.'});
  },
 };
}
