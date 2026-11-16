// Chatagent-owned host: scope and durable receipts stay independent of API credentials.
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL,fileURLToPath} from 'node:url';
export async function loadConfiguredMusicHost(root,{loadedAccount,mappings,profiles,accountReady,readWorkMode,readDshAccess,transport}){
 const directory=path.join(root,'packages/wechat-music'),load=rel=>import(pathToFileURL(path.join(directory,rel)).href);
 const {mediaLedger,mediaId,mediaDay}=await load('../media-experiences/ledger-chatagent.mjs'),{createRotatingHostScope}=await load('scope.mjs'),{createRemoteSource}=await load('remote-source.mjs'),{createMusicService}=await load('service.mjs'),{createJournal}=await load('journal.mjs'),{createMusicArchive}=await load('archive.mjs'),{sha}=await load('contracts.mjs');
 const configFile=path.join(root,'config/music-tool.json');
 const policy=()=>{try{return JSON.parse(fs.readFileSync(configFile,'utf8'));}catch{return {};}};
 const config=policy();if(config.enabled!==true)return null;
 if(!['music-host-v1','music-host-v2','music-host-v3'].includes(config.schema)||(config.schema==='music-host-v1'?config.maxCalls!==12:config.maxCalls!==40)||config.maxPerSource!==8||typeof config.python!=='string'||!path.isAbsolute(config.python))throw Error('MUSIC_CONFIG_INVALID');
 const frozen=JSON.stringify(config),expected=Object.freeze({...config.scope});let blocked=false;
 const rotating=createRotatingHostScope({expected,anchorFile:path.join(root,'state/accounts',expected.accountId,'music-authority',mediaId(JSON.stringify(expected))+'.json'),current:()=>{
  const key=expected.conversationKey,p=profiles[key]??{},current=policy();
  return {accountId:loadedAccount.id,conversationKey:key,sessionId:mappings[key],generation:p.generation,previousSessions:p.previousSessions,personaDigest:p.digest,instructionsDigest:p.instructionsDigest,persona:p.persona,instructions:p.instructions,
   workMode:readWorkMode(root,key),allowed:readDshAccess(root,key).tools.includes('wechat_music__listen'),accountReady:!blocked&&accountReady()&&JSON.stringify(current)===frozen};
 }});
 const scopeValid=rotating.check;
 // Loading is local and lazy: API credentials and cloud access happen only
 // after a valid tool admission and the durable request reservation.
 const sourceProvider=createRemoteSource({directory:path.join(directory,'state/source'),python:config.python});
 const daily=config.schema!=='music-host-v1',journal=createJournal(path.join(directory,'state/requests'),{maxCalls:daily?40:12,daily});
 const opportunities=daily?mediaLedger({root,account:expected.accountId,key:expected.conversationKey,musicRecovery:true}):null;
 if(opportunities){const prefix=sha(JSON.stringify([expected.sessionId,expected.accountId,expected.conversationKey]))+':';for(const r of journal.entries().filter(r=>!r.opportunityId&&r.storeKey?.startsWith(prefix)&&Number.isFinite(Date.parse(r.at)))){try{opportunities.reserveRound('music','legacy-'+mediaId(r.storeKey+'\0'+mediaDay(r.at)),{at:Date.parse(r.at),limit:5});}catch(error){if(error.message!=='MEDIA_DAILY_LIMIT')throw error;}}}
 // Rebuild confirmation facts only from the already verified, scoped journal.
 if(opportunities){const prefixes=new Set([mappings[expected.conversationKey],expected.sessionId,...(profiles[expected.conversationKey]?.previousSessions??[])].map(sid=>sha(JSON.stringify([sid,expected.accountId,expected.conversationKey]))+':'));for(const r of journal.entries()){if(!prefixes.has(r.storeKey?.slice(0,65))||r.phase!=='returned'||r.status!=='observed'||r.httpStatus!==200||r.nativeStop!==true||r.wireAudioVerified!==true||!r.description||!r.asset?.seconds)continue;const roundId=r.opportunityId??('legacy-'+mediaId(r.storeKey+'\0'+mediaDay(r.at)));if(opportunities.round(roundId)&&(opportunities.outcome(roundId)?.confirmed_ms??0)<Math.ceil(r.asset.seconds*1000))opportunities.confirmMusic(roundId,r.asset.seconds,r.source.bvid);}}
 const service=createMusicService({sourceProvider,journal,archive:createMusicArchive(path.join(directory,'state/reports')),maxPerSource:8,productionSessionUsed:true,daily,opportunities,onObserved:opportunities?((b,r)=>{const title=sourceProvider.metadata?.(b.source)?.pageTitle??b.source.bvid;opportunities.addExperience({id:'music-'+mediaId([b.accountId,b.conversationKey,r.source.bvid,r.asset.sha256,r.at].join('\0')),kind:'music',bvid:r.source.bvid,cid:r.source.cid,title,at:r.at,feeling:'',start:r.asset.start,end:r.asset.end,coverage:{audioSha256:r.asset.sha256,requestCompleted:true,completeTrack:r.asset.completeTrack}});}):undefined,
  transport});
 const payloadDigest=sha(fs.readFileSync(fileURLToPath(import.meta.url)));
 return {service,sourceProvider,scopeValid,historyBvids(){const sessions=[mappings[expected.conversationKey],expected.sessionId,...(profiles[expected.conversationKey]?.previousSessions??[])],prefixes=new Set(sessions.map(sid=>sha(JSON.stringify([sid,expected.accountId,expected.conversationKey]))+':'));return [...new Set(journal.entries().filter(r=>prefixes.has(r.storeKey?.slice(0,65))).map(r=>r.source?.bvid).filter(Boolean))];},historyScopeForSession:sid=>{const active=rotating.binding();return active?.sessionId===sid?active:null;},payloadDigest,get status(){if(blocked)return 'unavailable';try{return rotating.binding()?'ready':'scope_unavailable';}catch{return 'scope_unavailable';}},disable(){blocked=true;},async close(){try{await sourceProvider.close();}finally{opportunities?.close();}}};
}
