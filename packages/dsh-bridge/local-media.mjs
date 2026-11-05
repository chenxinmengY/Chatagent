// Optional DSH-side adapter for the user's existing local voice installation.
// The bridge itself does not require an ASR or voice engine.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {AttachmentStore} from '../storage/attachments.mjs';
import {createAudioInput} from '../dsh-adapter/audio-input.mjs';
import {createIsolatedAsrProvider} from '../companion-capabilities/isolated-asr.mjs';
import {createIsolatedTtsProvider} from '../companion-capabilities/isolated-tts.mjs';
import {MediaDelivery} from '../companion-capabilities/media.mjs';
import {connectLocalSinging} from './local-singing.mjs';
import {connectLocalHearing} from './local-hearing.mjs';

export async function connect({agent,root,config,publish,lookup,profile}){
  const attachments=new AttachmentStore(config.attachmentsRoot),db=new DatabaseSync(path.join(root,'audio.sqlite'));
  const input=createAudioInput({db,root,recognize:createIsolatedAsrProvider({root:config.asrRoot})});
  const store={publish,lookup:(_,id)=>lookup(id)},binding={store,attachments};input.attach(binding);
  const singing=connectLocalSinging({agent,root:path.join(root,'singing-capability'),configFile:config.singingFile,binding});
  const hearing=await connectLocalHearing({agent,root,workspace:config.hearingWorkspace,asrRoot:config.asrRoot,attachments,db,profile});
  const outputs=path.join(root,'media');fs.mkdirSync(outputs,{recursive:true});
  const media=new MediaDelivery({root:outputs});media.attach(binding);
  const tts=config.ttsRoot?createIsolatedTtsProvider({root:config.ttsRoot}):null;
  let queue=Promise.resolve();const controllers=new Set();
  const dispose=tts?agent.ctx.tools.register({name:'chatagent_send_voice',description:'将本轮要说的中文合成为语音，发送到 Chatagent 聊天窗口。用户要求普通语音时使用；不要把工具调用前准备描述成已发出。',parameters:{type:'object',properties:{text:{type:'string',minLength:1,maxLength:220}},required:['text'],additionalProperties:false},output:{schema:{type:'object',properties:{text:{type:'string'}},required:['text']},render:(_,r)=>[{type:'text',text:r.text}]},async execute({text}){
    const id='voice-'+randomUUID(),controller=new AbortController();controllers.add(controller);
    try{const result=await tts.synthesize({text,directory:outputs,id,signal:controller.signal});await media.audio({id,...result,name:'语音回复.wav',text:'语音回复',mode:'social',signal:controller.signal,maxSeconds:600});return {text:'语音已交给 Chatagent 待投递；不代表手机已播放。'};}finally{controllers.delete(controller);}
  }}):null;
  return {async prepare(request){const result=await input.prepare(request);return result.failure?result:{...result,hearingAttachments:request.attachments};},async before(request){hearing?.before(request);await singing?.before(request);},after(){hearing?.after();singing?.after();},transcription({id,start}){return start?input.requestTranscription(id,action=>{queue=queue.then(action).catch(()=>{});}):input.transcription(id);},cancel(){for(const c of controllers)c.abort();hearing?.after();singing?.cancel();},async close(){this.cancel();await queue;hearing?.close();await singing?.close();dispose?.();await tts?.close();media.close();db.close();attachments.close();}};
}
