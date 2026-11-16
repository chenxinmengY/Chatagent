import {randomUUID} from 'node:crypto';

// Record returned usage even when the provider ends with an error or a limit.
// Never retry an incomplete or uncertain generation here.
export function pluginGenerator({ctx,agent,llm}){
 return async({prompt,images=[],signal,maxTokens=1800,maxChars=3000,onUsage})=>{
  if(!llm)throw Error('PLUGIN_MODEL_UNAVAILABLE');
  const selection=ctx.get('sessionController')?.agents.selectionFor?.(agent)?.current??agent.session.requestHeader()?.config??agent.options;
  if(!selection?.provider||!selection?.model)throw Error('PLUGIN_MODEL_UNAVAILABLE');
  const service=ctx.get('llm'),content=[{type:'text',text:prompt}];
  if(images.length){if(selection.provider==='notion-chatagent')throw Error('PLUGIN_MODEL_VISION_REQUIRED');const attachments=ctx.get('attachments');if(!attachments)throw Error('PLUGIN_IMAGES_UNAVAILABLE');const info=await service.resolveModelInfo(selection.provider,selection.model,signal);if(!info.inputModalities?.includes('image'))throw Error('PLUGIN_MODEL_VISION_REQUIRED');for(const data of images){signal.throwIfAborted();content.push({type:'image',attachment:await attachments.saveImage({data,mediaType:'image/jpeg',name:'视频抽帧.jpg'})});}}
  const assembler=new llm.BlockAssembler();let length=0,finish;
  try{
   for await(const chunk of service.stream({provider:selection.provider,model:selection.model,...selection.reasoningEffort?{reasoningEffort:selection.reasoningEffort}:{},sessionId:'chatagent-plugin-'+randomUUID(),messages:[llm.createUserMessage({source:{kind:'chatagent-plugin'},content})],tools:[],maxTokens,signal})){
    signal.throwIfAborted();assembler.push(chunk);if(chunk.type==='finish')finish=chunk.reason;
    if(chunk.type==='text-delta'){length+=chunk.text.length;if(length>maxChars)throw Error('PLUGIN_OUTPUT_INVALID');}
   }
  }finally{onUsage?.(assembler.usage);}
  signal.throwIfAborted();
  if(finish?.kind!=='stop'){
   const code=finish?.kind==='max-tokens'?'PLUGIN_OUTPUT_LIMIT':finish?.kind==='error'?'PLUGIN_MODEL_FAILED':finish?.kind==='aborted'?'PLUGIN_MODEL_ABORTED':'PLUGIN_OUTPUT_INCOMPLETE';
   throw Object.assign(Error(code),{details:{finishKind:finish?.kind??'missing',.../^[A-Z][A-Z0-9_]{0,99}$/.test(finish?.failure?.code??'')?{failureCode:finish.failure.code}:{}}});
  }
  const text=assembler.blocks().filter(b=>b.type==='text').map(b=>b.text).join('').trim();if(text.length>maxChars)throw Error('PLUGIN_OUTPUT_INVALID');return text;
 };
}
