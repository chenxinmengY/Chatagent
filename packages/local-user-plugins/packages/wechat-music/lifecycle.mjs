// Only current, explicit bridge descriptors can grant a music turn.
export async function openMusicTurn({turns,sid,key,batchId,descriptor,signal,skip=false,autonomousOpportunity,onFailure=()=>{}}){
 if(!turns||descriptor===undefined||skip&&descriptor.stop!==true||! /^[a-f0-9]{64}$/.test(batchId??''))return {context:'',admission:null};
 let admission;
 try{
  admission=await turns.admit({sessionId:sid,conversationKey:key,message:'',messageId:batchId,descriptor,signal,autonomousOpportunity});
  if(!admission&&autonomousOpportunity&&descriptor?.invitation?.bvid)return {admission:null,sourceFailure:'MUSIC_SCOPE_UNAVAILABLE',context:'\n本轮音乐状态：听歌授权或当前角色状态校验未通过，未提供音频，不能声称听过。'};
  return {admission,context:admission?'\n本轮临时音乐资料：\n'+admission.context():''};
 }catch(error){
  if(admission){admission.release();try{await admission.cleanup();}catch{onFailure('MUSIC_CLEANUP_UNAVAILABLE');}}
  signal.throwIfAborted();
  const expected=/^MUSIC_(?:SOURCE_[A-Z_]+|NO_PUBLIC_AUDIO|MULTIPART_REQUIRES_SELECTION|CDN_REJECTED|REDIRECT_REJECTED|DOWNLOAD_TIMEOUT|MEDIA_REJECTED|AUDIO_SIZE|AUDIO_PREPARATION_FAILED|PCM_BINDING|TEMP_[A-Z_]+|RECORDING_CHANGED)$/.test(error.message);
  if(!expected)onFailure('MUSIC_TURN_UNAVAILABLE');
  return {admission:null,sourceFailure:expected?error.message:'MUSIC_TURN_UNAVAILABLE',context:'\n本轮音乐状态：音乐工具暂不可用，未提供新音频或其他歌曲的结果。不能声称听过；可自然说明暂时无法听取。'};
 }
}
export async function finishMusicTurn(turn,agent,controller,{onFailure=()=>{}}={}){
 if(!turn?.admission)return;
 turn.admission.release();controller.abort();
 try{
  if(agent.status==='running')await agent.whenIdle();
  if(agent.status==='running')throw Error('MUSIC_AGENT_NOT_SETTLED');
  await turn.admission.cleanup();return {status:'released'};
 }catch{onFailure('MUSIC_CLEANUP_UNAVAILABLE');return {status:'cleanup_unavailable',ownerRetained:true};}
}
