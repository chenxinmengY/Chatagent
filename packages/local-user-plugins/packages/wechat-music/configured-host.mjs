import {mediaLedger,mediaId,mediaDay} from '../media-experiences/ledger.mjs';
import fs from 'node:fs';import path from 'node:path';
import {createRotatingHostScope} from './scope.mjs';
import {createRemoteSource} from './remote-source.mjs';
import {createMusicService} from './service.mjs';
import {createJournal} from './journal.mjs';
import {createMusicArchive} from './archive.mjs';
import {obtainCredential,subscriptionFetch} from './subscription.mjs';
import {infer} from './inference.mjs';
import {sha} from './contracts.mjs';
export function loadConfiguredMusicHost(root,{loadedAccount,mappings,profiles,accountReady,readWorkMode,readDshAccess}){
 const configFile=path.join(root,'config/music-tool.json');
 const policy=()=>{try{return JSON.parse(fs.readFileSync(configFile,'utf8'));}catch{return {};}};
 const config=policy();if(config.enabled!==true)return null;
 if(!['music-host-v1','music-host-v2'].includes(config.schema)||(config.schema==='music-host-v1'?config.maxCalls!==12:config.maxCalls!==40)||config.maxPerSource!==8||typeof config.python!=='string'||!path.isAbsolute(config.python)||! /^[a-f0-9]{64}$/.test(config.subscriptionAccountHash??''))throw Error('MUSIC_CONFIG_INVALID');
 const frozen=JSON.stringify(config),expected=Object.freeze({...config.scope});let blocked=false;
 const rotating=createRotatingHostScope({expected,anchorFile:path.join(root,'state/accounts',expected.accountId,'music-authority',mediaId(JSON.stringify(expected))+'.json'),current:()=>{
  const key=expected.conversationKey,p=profiles[key]??{},current=policy();
  return {accountId:loadedAccount.id,conversationKey:key,sessionId:mappings[key],generation:p.generation,previousSessions:p.previousSessions,personaDigest:p.digest,instructionsDigest:p.instructionsDigest,persona:p.persona,instructions:p.instructions,
   workMode:readWorkMode(root,key),allowed:readDshAccess(root,key).tools.includes('wechat_music__listen'),accountReady:!blocked&&accountReady()&&JSON.stringify(current)===frozen};
 }});
 const scopeValid=rotating.check;
 // Loading is local and lazy: credentials, refresh and cloud access happen only
 // after a valid tool admission and the durable request reservation.
 const sourceProvider=createRemoteSource({directory:path.join(import.meta.dirname,'state/source'),python:config.python});
 const daily=config.schema==='music-host-v2',journal=createJournal(path.join(import.meta.dirname,'state/requests'),{maxCalls:daily?40:12,daily});
 const opportunities=daily?mediaLedger({root,account:expected.accountId,key:expected.conversationKey}):null;
 if(opportunities){const prefix=sha(JSON.stringify([expected.sessionId,expected.accountId,expected.conversationKey]))+':';for(const r of journal.entries().filter(r=>!r.opportunityId&&r.storeKey?.startsWith(prefix)&&Number.isFinite(Date.parse(r.at)))){try{opportunities.reserveRound('music','legacy-'+mediaId(r.storeKey+'\0'+mediaDay(r.at)),{at:Date.parse(r.at),limit:5});}catch(error){if(error.message!=='MEDIA_DAILY_LIMIT')throw error;}}}
 // Rebuild confirmation facts only from the already verified, scoped journal.
 if(opportunities){const prefixes=new Set([mappings[expected.conversationKey],expected.sessionId,...(profiles[expected.conversationKey]?.previousSessions??[])].map(sid=>sha(JSON.stringify([sid,expected.accountId,expected.conversationKey]))+':'));for(const r of journal.entries()){if(!prefixes.has(r.storeKey?.slice(0,65))||r.phase!=='returned'||r.status!=='observed'||r.httpStatus!==200||r.nativeStop!==true||r.wireAudioVerified!==true||!r.description||!r.asset?.seconds)continue;const roundId=r.opportunityId??('legacy-'+mediaId(r.storeKey+'\0'+mediaDay(r.at)));if(opportunities.round(roundId))opportunities.confirmMusic(roundId,r.asset.seconds,r.source.bvid);}}
 const service=createMusicService({sourceProvider,journal,archive:createMusicArchive(path.join(import.meta.dirname,'state/reports')),maxPerSource:8,productionSessionUsed:true,daily,opportunities,onObserved:opportunities?((b,r)=>{const title=sourceProvider.metadata?.(b.source)?.pageTitle??b.source.bvid;opportunities.addExperience({id:'music-'+mediaId([b.accountId,b.conversationKey,r.source.bvid,r.asset.sha256,r.at].join('\0')),kind:'music',bvid:r.source.bvid,cid:r.source.cid,title,at:r.at,feeling:'',start:r.asset.start,end:r.asset.end,coverage:{audioSha256:r.asset.sha256,requestCompleted:true,completeTrack:r.asset.completeTrack}});}):undefined,
  transport:async options=>{if(!rotating.binding())throw Error('MUSIC_HOST_REVOKED');const {credential,codec}=await obtainCredential(config.subscriptionAccountHash);try{options.signal?.throwIfAborted();if(!rotating.binding())throw Error('MUSIC_HOST_REVOKED');return await infer({...options,credential,codec,fetcher:subscriptionFetch});}finally{credential.token='';}}});
 const files=fs.readdirSync(import.meta.dirname).filter(n=>/\.(mjs|py|ps1)$/.test(n)).sort();
 const payloadDigest=sha(Buffer.concat(files.map(n=>Buffer.concat([Buffer.from(n+'\0'),fs.readFileSync(path.join(import.meta.dirname,n))]))));
 return {service,sourceProvider,scopeValid,historyScopeForSession:sid=>{const active=rotating.binding();return active?.sessionId===sid?active:null;},payloadDigest,get status(){if(blocked)return 'unavailable';try{return rotating.binding()?'ready':'scope_unavailable';}catch{return 'scope_unavailable';}},disable(){blocked=true;},async close(){try{await sourceProvider.close();}finally{opportunities?.close();}}};
}
export function tryLoadConfiguredMusicHost(root,dependencies,load=loadConfiguredMusicHost){
 try{return {host:load(root,dependencies),failure:null};}catch{return {host:null,failure:'MUSIC_HOST_UNAVAILABLE'};}
}
