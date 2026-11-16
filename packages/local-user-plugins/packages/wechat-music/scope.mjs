// Chatagent adapter: the native UUID is pinned by the local migration config.
import {createHash} from 'node:crypto';
const sha=s=>createHash('sha256').update(s).digest('hex');
export function createRotatingHostScope({expected,current}){
 const pinned=structuredClone(expected),fields=['accountId','conversationKey','sessionId','generation','personaDigest','instructionsDigest'];
 if(!/^chatagent-[a-f0-9-]{36}$/.test(pinned.sessionId)||!/^wechat:private:[1-9]\d{0,15}$/.test(pinned.conversationKey)||!['accountId','personaDigest','instructionsDigest'].every(k=>/^[a-f0-9]{64}$/.test(pinned[k])))throw Error('MUSIC_HOST_SCOPE_CONFIG_INVALID');
 const binding=()=>{const live=current();if(!live||!fields.every(k=>live[k]===pinned[k])||live.accountReady!==true||live.allowed!==true||live.workMode!=='social'||sha(live.persona)!==pinned.personaDigest||sha(live.instructions)!==pinned.instructionsDigest)return null;return {...pinned,historySessionIds:[...new Set([...(live.previousSessions??[]).filter(s=>/^social-[a-f0-9]{32}$/.test(s)),pinned.sessionId])]};};
 return {binding,check:b=>{const live=binding();return !!live&&['accountId','conversationKey','sessionId'].every(k=>b?.[k]===live[k]);}};
}
