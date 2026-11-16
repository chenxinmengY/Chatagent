import fs from 'node:fs';
import {createHash} from 'node:crypto';

const imageTypes=new Set(['image/png','image/jpeg','image/webp','image/gif']);

// Verify every original before invoking ASR or staging native attachments.
export async function prepareAttachments(request,{attachments,audio,uploadFile,imageLimits,previewGif}){
  let checked;
  try{
    checked=request.attachments.map(item=>{
      const file=attachments.verify(item.id);
      if(file.sha256!==item.sha256||file.bytes!==item.bytes||file.media_type!==item.mediaType||file.name!==item.name)throw Error('ATTACHMENT_CHANGED');
      return file;
    });
  }catch{return {failure:'附件完整性校验失败，原消息已保留，没有发送给对话模型。请重新选择文件。'};}
  const images=checked.filter(file=>imageTypes.has(file.media_type));
  if(imageLimits&&(images.length>imageLimits.maxImagesPerMessage||images.some(file=>file.bytes>imageLimits.maxImageBytes)||images.reduce((n,file)=>n+file.bytes,0)>imageLimits.maxMessageImageBytes))return {failure:'图片已保存，但超过当前模型的图片输入大小限制，没有发送给对话模型。请缩小图片后重新发送。'};
  const voices=request.attachments.filter(item=>item.mediaType.startsWith('audio/'));
  const prepared=voices.length?await audio.prepare({...request,attachments:voices}):request;
  if(prepared.failure)return prepared;
  const content=[{type:'text',text:prepared.text||'请看看我发来的附件。'}],animationViews=[];
  try{
    for(const file of checked){
      if(file.media_type.startsWith('audio/'))continue;
      const bytes=fs.readFileSync(file.file);if(bytes.length!==file.bytes||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('ATTACHMENT_CHANGED');
      const data=bytes.toString('base64');
      if(imageTypes.has(file.media_type)){
        if(file.media_type==='image/gif'&&previewGif){
          const {data,mediaType,...view}=await previewGif(bytes);animationViews.push({attachmentId:file.id,...view});
          content.push({type:'text',text:`以下是这张 GIF 的时序选帧：原图共 ${view.totalFrames} 帧，一轮约 ${(view.durationMs/1000).toFixed(2)} 秒；已按顺序抽取 ${view.frameCount} 帧覆盖开头到结尾。每个边框内是独立一帧，从左到右、从上到下排列，标有时间和帧号。比较物体在各自边框内的位置，拼图换行不代表动作返回起点。请结合多帧判断实际动作变化，未展示的细节不推测。`},{type:'image',mediaType,name:file.name+'-frames.jpg',data:data.toString('base64')});
        }
        else content.push({type:'image',mediaType:file.media_type,name:file.name,data});
      }
      else content.push({type:'file',receiptId:(await uploadFile({data,name:file.name})).receiptId});
    }
  }catch{return {failure:'附件已保存，但本轮未能交给对话模型，没有自动重试。请稍后重新发送。'};}
  return {...prepared,attachments:[],promptContent:content,hearingAttachments:voices,animationViews};
}
