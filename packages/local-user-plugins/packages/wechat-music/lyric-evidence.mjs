// Evidence boundary, not a detector of whether a lyric source is truthful.
// A source is verified separately by the retrieval/review layer.
import {createHash} from 'node:crypto';import {lyricPrompt} from './tasks.mjs';
export function composeLyricEvidence(blind,assisted,source){
 if(!blind?.nativeStop||!blind.description||blind.arm!=='blind'||blind.kind!=='lyric')return {status:'unconfirmed',audioObservation:null,referenceCandidate:null};
 const audioObservation=structuredClone(blind.description);
 if(!assisted?.nativeStop||!assisted.description||assisted.kind!=='lyric'||assisted.id!==blind.id||
  assisted.asset?.sha256!==blind.asset?.sha256)return {status:'audio_observation_only',audioObservation,referenceCandidate:null,reason:'Assistance incomplete or bound to different audio.'};
 if(source?.provenanceVerified!==true||typeof source.text!=='string'||!source.text.trim()||!/^\w[\w:/.-]{0,199}$/.test(source.sourceId??'')||!/^\w[\w:/.-]{0,199}$/.test(source.recordingId??'')||
  !/^[a-f0-9]{64}$/.test(source.evidenceSha256??''))return {status:'reference_withheld',audioObservation,referenceCandidate:null,reason:'An agreeing model answer does not verify an external lyric source.'};
 const referencePromptSha256=createHash('sha256').update(lyricPrompt(source.text)).digest('hex');
 if(referencePromptSha256!==assisted.promptSha256)
  return {status:'reference_withheld',audioObservation,referenceCandidate:null,reason:'The reviewed reference is not bound to this assisted request.'};
 return {status:'separate_evidence',audioObservation,
  referenceCandidate:{text:source.text,assistedObservation:structuredClone(assisted.description),sourceId:source.sourceId,recordingId:source.recordingId,evidenceSha256:source.evidenceSha256,assistedPromptSha256:referencePromptSha256,
   basis:'external_reference_assisted',independentAcousticVerification:false},
  limitation:'Keep blind hearing and reference-assisted correction separate. Verified provenance can still contain a wrong lyric or wrong version.'};
}
