import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomic,read,sha,checkedSegments} from './common.mjs';
import {parseInvitation,stopIntent,outgoingProposal} from './intent.mjs';
import {checkedMp3} from './mp3.mjs';

// A single Bridge owns this state and its authenticated listener. There is no
// task queue and recovery never starts a send or a generation.
export function createSingingService({directory,scope,allowed,worker,source,transport,recipeDigest,rows=()=>[],onRecord=()=>{},beforeJob=()=>{},notification,encodeWhole,retention,now=Date.now}) {
  fs.mkdirSync(directory,{recursive:true});
  const stateFile=path.join(directory,'ledger.json');
  const state=fs.existsSync(stateFile)?read(stateFile):{schema:'wechat-singing-v1',jobs:[],cache:{}};
  if(state.schema!=='wechat-singing-v1'||!Array.isArray(state.jobs)||!state.cache||typeof state.cache!=='object') throw Error('SINGING_STATE_INVALID');
  const save=()=>atomic(stateFile,state);
  for(const job of state.jobs) {
    if(job.failureNotice?.status==='queued')job.failureNotice.status='cancelled';
    else if(job.failureNotice?.status==='submitting')job.failureNotice.status='unknown';
    if(['preparing','making','ready','sending'].includes(job.status)) {
      job.status='interrupted'; job.error='restart_does_not_resume';job.finishedAt??=now();
      for(const part of job.parts??[]) if(!['confirmed','unknown'].includes(part.status)) part.status=part.status==='submitting'?'unknown':'cancelled';
    }
  }
  save();
  let active=null,invitation=null,closed=false,background=Promise.resolve(),reconciling=null,notifying=null;
  const authorized=b=>!closed&&b?.sessionId===scope.sessionId&&b?.conversationKey===scope.conversationKey&&allowed(scope)===true;
  const binding={sessionId:scope.sessionId,conversationKey:scope.conversationKey};
  const summary=job=>job?{id:job.id,status:job.status,stage:job.stage,bvid:job.request.bvid,mode:job.request.mode,deliveryKind:job.deliveryKind??'voice',cacheHit:job.cacheHit??false,totalSegments:job.parts?.filter(p=>p.kind!=='mp3').length??0,sentSegments:job.parts?.filter(p=>p.kind!=='mp3'&&p.status==='confirmed').length??0,totalFiles:job.parts?.filter(p=>p.kind==='mp3').length??0,sentFiles:job.parts?.filter(p=>p.kind==='mp3'&&p.status==='confirmed').length??0,elapsedSeconds:Math.max(0,(job.finishedAt??now())-job.request.createdAt)/1000,errorCode:job.error??null}:null;
  const response=(status,extra={})=>({binding,status,...extra});
  const validInvite=id=>invitation?.id===id&&now()-invitation.request.createdAt<=300000&&!invitation.consumed;
  const keyFor=(request,identity)=>sha(JSON.stringify({recording:identity,mode:request.mode,start:request.start??0,end:request.end??null,recipeDigest}));
  const verifiedFor=(request,file)=>request.mode==='whole'?checkedMp3(file):checkedSegments(file);
  const manifestFor=(request,entry)=>request.mode==='whole'?entry?.mp3Manifest:entry?.segmentsManifest;
  const transportFor=part=>part?.kind==='mp3'?transport.file:transport;
  function cachedAvailable(request){
    try{if(request.remake)return false;const recording=source.peek?.(request.bvid),entry=recording&&state.cache[keyFor(request,recording.identity)];return !!entry&&entry.recipeDigest===recipeDigest&&JSON.stringify(entry.source)===JSON.stringify(recording.identity)&&verifiedFor(request,manifestFor(request,entry)).manifestSha256===entry.manifestSha256;}catch{return false;}
  }
  const check=(job,signal)=>{signal.throwIfAborted();if(closed||active?.job!==job||!authorized(binding)||job.cancelRequested) throw Error('SINGING_CANCELLED');};
  async function deliverNotice() {
    if(!notification||closed)return;
    for(const job of state.jobs) {
      const notice=job.failureNotice;
      if(notice?.status!=='queued')continue;
      if(!authorized(binding)||job.cancelRequested){notice.status='cancelled';save();continue;}
      if(!notification.isReady())return;
      await notification.withLock(scope.conversationKey,async()=>{
        if(notice.status!=='queued'||!authorized(binding)||job.cancelRequested||!notification.isReady())return;
        notice.status='submitting';notice.attempts=1;notice.submittedAt=now();save();
        let result;
        try{result=await notification.send({conversationKey:scope.conversationKey,text:notice.text,deliveryId:notice.deliveryId});}
        catch{result=null;}
        notice.status=result?.confirmed===true&&result?.delivered==='database-confirmed'?'confirmed':'unknown';
        notice.completedAt=now();save();
        try{notification.record?.(job,notice);}catch{job.noticeRecordWarning=true;save();}
      });
    }
  }
  function tick() {
    if(retention&&!active&&!closed){try{if(retention.sweep(state.jobs,{busy:!!active,persist:save}))save();}catch{}}
    if(!notifying)notifying=deliverNotice().catch(()=>{}).finally(()=>{notifying=null;});
    return notifying;
  }
  async function produce(job,controller) {
    const signal=controller.signal;
    try {
      check(job,signal);
      await beforeJob({signal});check(job,signal);
      const recording=await source.resolve(job.request,{signal,onOwned:folder=>{job.sourceFolder=folder;save();}});
      check(job,signal);
      job.source=recording.identity;
      job.sourcePath=recording.path;
      const cacheKey=keyFor(job.request,recording.identity);
      const entry=!job.request.remake&&state.cache[cacheKey];
      let manifest=manifestFor(job.request,entry);
      if(entry) {
        try {const verified=verifiedFor(job.request,manifest);if(verified.manifestSha256!==entry.manifestSha256||entry.recipeDigest!==recipeDigest||JSON.stringify(entry.source)!==JSON.stringify(recording.identity))throw Error('cache changed');job.cacheHit=true;}
        catch { manifest=null;job.cacheInvalid=true; }
      }
      if(!manifest) {
        job.status='making';job.stage='source';save();
        const input=await source.prepare(recording,job.request,{id:job.id,signal});check(job,signal);
        job.preparedInput=input.path;job.workerStarted=true;job.workerOwnerReport=worker.ownershipReport;if(worker.runtimeDirectory)job.workerManifest=path.join(worker.runtimeDirectory,'jobs',job.id,'manifest.json');save();
        const completed=await worker.run({id:job.id,inputPath:input.path,inputSha256:input.sha256,mode:job.request.mode,signal,onArtifacts:file=>{job.workerManifest=file;save();},onProgress:stage=>{if(active?.job===job){job.stage=stage;save();}}});
        check(job,signal);
        if(job.request.mode==='whole'){
          if(typeof encodeWhole!=='function'||!transport.file)throw Error('SINGING_MP3_UNAVAILABLE');
          job.stage='mp3';save();manifest=await encodeWhole({id:job.id,bvid:job.request.bvid,title:recording.title,master:completed.master,signal});
        }else manifest=completed.segmentsManifest;
      }
      const verified=verifiedFor(job.request,manifest);
      await beforeJob({signal});
      check(job,signal);
      const manifestKey=job.request.mode==='whole'?'mp3Manifest':'segmentsManifest';
      state.cache[cacheKey]={[manifestKey]:manifest,manifestSha256:verified.manifestSha256,source:recording.identity,recipeDigest,createdAt:now()};
      job.status='ready';job.stage='checked';job[manifestKey]=manifest;
      job.parts=verified.parts.map(part=>({...part,deliveryId:sha(job.id+'\0'+part.index),status:'queued'}));save();
      // Every part is validated before the first irreversible request. Each
      // submitting marker is fsynced before entering the transport.
      for(const part of job.parts) {
        check(job,signal);
        await beforeJob({signal});check(job,signal);
        if(sha(fs.readFileSync(part.file))!==part.sha256) throw Error('SINGING_PART_CHANGED');
        const selectedTransport=transportFor(part);
        await selectedTransport.preflight({conversationKey:scope.conversationKey,signal});check(job,signal);
        part.status='submitting';part.attempts=1;part.submittedAt=now();job.status='sending';job.stage='send-'+part.index;save();
        let result;
        try {result=await selectedTransport[part.kind==='mp3'?'sendFile':'sendSegment']({...part,conversationKey:scope.conversationKey,signal,onStaged:staged=>{part.staged=staged;save();},beforeSubmit:context=>{check(job,signal);part.receiptContext=context.receiptContext;part.submissionEvidence=context;save();}});}
        catch {result={status:'unknown'};}
        // Cancellation never rewrites a possibly submitted part as unsent.
        part.status=result.status==='confirmed'?'confirmed':result.status==='rejected'?'failed':'unknown';
        part.receipt=result;part.completedAt=now();save();
        try {onRecord(job,part);}catch {job.recordWarning=true;save();}
        if(part.status!=='confirmed') {
          job.status=job.cancelRequested?'cancelled':part.status==='unknown'?'unknown':'error';
          for(const next of job.parts) if(next.status==='queued')next.status='cancelled';
          save();return;
        }
      }
      job.status=job.cancelRequested?'cancelled':'complete';
    } catch(error) {
      job.status=controller.signal.aborted||job.cancelRequested?'cancelled':'error';
      job.error=job.status==='cancelled'?'cancelled':/^SINGING_[A-Z_]+$/.test(error.message)?error.message:'SINGING_JOB_FAILED';
      for(const part of job.parts??[]) if(part.status==='queued')part.status='cancelled';else if(part.status==='submitting')part.status='unknown';
    } finally {
      job.finishedAt=now();
      if(notification&&['error','unknown'].includes(job.status)&&!job.cancelRequested&&!closed) {
        const uncertain=job.parts.some(p=>p.status==='unknown');
        const sent=job.parts.some(p=>p.status==='confirmed');
        const requestedAt=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(job.request.createdAt);
        const subject='你在'+requestedAt+'点唱的 '+job.request.bvid+'（'+(job.request.mode==='whole'?'整首':'翻唱片段')+'）';
        const media=job.deliveryKind==='mp3'?'MP3附件':'语音';
        const text=subject+(uncertain?'有'+media+'的发送结果没能确认，我已停下该次任务的后续发送，不会自动补发。':sent?'没能完成，已停止该次任务的后续发送，已确认发送的'+media+'会保留。':'没能完成，已经停下来了，没有发送该次翻唱的'+media+'。你可以稍后重新邀请我再试一次。');
        job.failureNotice={deliveryId:sha(job.id+'\0failure-notice'),text,status:'queued',attempts:0,createdAt:now()};
      }
      try{save();}finally{if(active?.job===job)active=null;}
      await tick();
    }
  }
  function stop() {
    invitation=null;
    for(const job of state.jobs)if(job.failureNotice?.status==='queued')job.failureNotice.status='cancelled';
    save();
    if(!active)return response('idle',{job:summary(state.jobs.at(-1))});
    const {job,controller}=active;job.cancelRequested=true;job.stage='stopping';
    for(const part of job.parts??[]) if(part.status==='queued')part.status='cancelled';
    try{save();}finally{controller.abort(Error('SINGING_CANCELLED'));try{worker.cancel?.(job.id);}catch{job.cancelWarning=true;}}
    return response('stopping',{job:summary(job)});
  }
  async function reconcile(job) {
    try {
      for(const part of job.parts??[]) {
        const selectedTransport=transportFor(part);
        if(!authorized(binding)||part.status!=='unknown'||!part.receiptContext||typeof selectedTransport?.reconcile!=='function')continue;
        const result=await selectedTransport.reconcile({conversationKey:scope.conversationKey,receiptContext:part.receiptContext});
        if(!authorized(binding))return;
        if(result.status==='confirmed'){
          part.status='confirmed';part.receipt=result;save();
          try{onRecord(job,part);}catch{job.recordWarning=true;}
        }
      }
      if(job.parts?.length&&job.parts.every(p=>p.status==='confirmed')&&job.status!=='cancelled')job.status='complete';
      else if(job.status==='unknown'&&!job.parts.some(p=>p.status==='unknown'))job.status='interrupted';
      save();
    }catch{}finally{reconciling=null;}
  }
  return {
    receive(message) {
      if(!authorized(binding)||message.platform!=='wechat'||message.kind!=='private'||String(message.conversation_id)!==scope.conversationKey.split(':')[2]||message.outgoing||message.forwardedRecord||message.quoteReply||message.interaction==='pat')return;
      const age=now()-Number(message.timestamp)*1000;
      if(!Number.isFinite(age)||age>90000||age< -5000)return;
      invitation=null;
      if(stopIntent(message.text)){stop();return;}
      const history=rows(scope.conversationKey);
      // Selection is only an explicit source in recent trusted chat; no fuzzy
      // song-name lookup and no ordinary recollection can create an invitation.
      let selected;
      for(const row of [...history].reverse()) {
        if(row.outgoing||row.forwardedRecord||row.quoteReply||/不是|不要|别|不想|引用|转发|[“”「」『』"]/.test(row.text??''))continue;
        if(now()-Number(row.timestamp)*1000>300000)break;
        const ids=[...new Set((row.text??'').match(/BV[1-9A-HJ-NP-Za-km-z]{10}/g)??[])];
        if(ids.length===1){selected={bvid:ids[0]};break;}
        if(ids.length>1)break;
      }
      const latest=state.jobs.at(-1)?.request;
      if(latest&&now()-latest.createdAt<=300000&&(!selected||selected.bvid===latest.bvid))selected={...latest};
      const request=parseInvitation(message,{proposal:outgoingProposal(history,now()),selected,now:now()});
      if(request)invitation={id:randomUUID(),request,consumed:state.jobs.some(j=>j.request.messageId===request.messageId)};
    },
    async control(body) {
      if(!authorized(body))throw Error('SINGING_SCOPE_DENIED');
      if(body.action==='stop')return stop();
      const workerStatus=worker.state==='unavailable'?'unavailable':'worker_preparing';
      if(body.action==='status'){
        const job=active?.job??state.jobs.at(-1);
        if(!active&&!reconciling&&job?.parts?.some(p=>p.status==='unknown'&&p.receiptContext&&transportFor(p)?.reconcile))reconciling=reconcile(job);
        return response(active?'working':job?.status??(worker.ready?'ready':workerStatus),{workerReady:worker.ready,job:summary(job),...(reconciling?{notice:'正在只读核对未确认片段；不会补发，也不会继续发送旧任务的其余片段。'}:{})});
      }
      if(body.action==='context')return response(active?'working':invitation?.request.needsSelection?'needs_selection':worker.ready||invitation&&cachedAvailable(invitation.request)?'ready':workerStatus,{workerReady:worker.ready,inviteId:invitation&&!invitation.consumed?invitation.id:null,invitation:invitation&&!invitation.consumed?invitation.request:null,job:summary(active?.job??state.jobs.at(-1))});
      if(body.action!=='sing')throw Error('SINGING_ACTION_INVALID');
      if(active)return response('busy',{job:summary(active.job)});
      if(!validInvite(body.inviteId))return response('needs_invitation');
      if(invitation.request.needsSelection)return response('needs_selection');
      if(!worker.ready&&!cachedAvailable(invitation.request))return response(workerStatus);
      const job={id:'song-'+randomUUID(),conversationKey:scope.conversationKey,sessionId:scope.sessionId,request:structuredClone(invitation.request),deliveryKind:invitation.request.mode==='whole'?'mp3':'voice',status:'preparing',stage:'source',createdAt:now(),parts:[]};
      invitation.consumed=true;state.jobs.push(job);save();
      const controller=new AbortController();active={job,controller};
      background=produce(job,controller);void background.catch(()=>{});
      return response('submitted',{job:summary(job)});
    },
    get busy(){return !!active;},
    interrupt(){return stop();},
    tick,
    async settled(){await background;await notifying;},
    async close(){stop();closed=true;await worker.close();await background;await notifying;await reconciling;},
    snapshot(){return structuredClone(state);},
  };
}
