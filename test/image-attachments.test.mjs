import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {AttachmentStore} from '../packages/storage/attachments.mjs';
import {prepareAttachments} from '../packages/dsh-bridge/attachment-input.mjs';
import {chatRecords,createChatWindow,recentWindow} from '../packages/dsh-bridge/chat-window.mjs';
import {projectWindowMessage} from '../packages/dsh-bridge/chat-continuity.mjs';
import {sandbox} from './helpers.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC','base64');
function fixture(t){
  let attachments;t.after(()=>attachments?.close());const box=sandbox(t);attachments=new AttachmentStore(path.join(box.root,'attachments'));
  const add=(name,bytes)=>{const file=path.join(box.root,name);fs.writeFileSync(file,bytes);const row=attachments.importFile(file,name);return {id:row.id,name:row.name,bytes:row.bytes,sha256:row.sha256,mediaType:row.media_type};};
  return {...box,attachments,add};
}
test('图片使用完整校验原件进入原生多模态内容，不调用语音转写且不改原消息',async t=>{
  const f=fixture(t),file=f.add('图片.png',png),request={id:'image',text:'看得到吗',attachments:[file]},before=structuredClone(request);
  const result=await prepareAttachments(request,{attachments:f.attachments,audio:{prepare(){throw Error('ASR_MUST_NOT_RUN');}}});
  assert.equal(result.promptContent[0].text,request.text);assert.deepEqual(result.promptContent[1],{type:'image',mediaType:'image/png',name:file.name,data:png.toString('base64')});
  assert.deepEqual(result.hearingAttachments,[]);assert.deepEqual(request,before);
});
test('图片和语音同发保留图片与转写，PDF为原生文件附件，不冒充已读正文',async t=>{
  const f=fixture(t),image=f.add('photo.png',png),voice=f.add('voice.wav',Buffer.from('RIFF0000WAVEsynthetic')),pdf=f.add('课程.pdf',Buffer.from('%PDF-1.4\nsynthetic'));
  assert.equal(pdf.mediaType,'application/pdf');let calls=0,uploaded;
  const request={id:'mixed',text:'文字',attachments:[image,voice,pdf]};
  const result=await prepareAttachments(request,{attachments:f.attachments,audio:{async prepare(r){calls++;assert.deepEqual(r.attachments,[voice]);return {...r,text:'文字\n语音内容',audioTranscription:true};}},uploadFile:async file=>{uploaded=file;return {receiptId:'native-file'};}});
  assert.equal(calls,1);assert.equal(result.promptContent[0].text,'文字\n语音内容');assert.equal(result.promptContent[1].type,'image');assert.deepEqual(result.promptContent[2],{type:'file',receiptId:'native-file'});assert.deepEqual(result.hearingAttachments,[voice]);
  assert.equal(uploaded.name,pdf.name);assert.equal(Buffer.from(uploaded.data,'base64').toString(),'%PDF-1.4\nsynthetic');
});
test('任意附件被替换时整体拒绝，不先调用ASR或文件上传；转写失败也不丢弃附件继续聊天',async t=>{
  const f=fixture(t),image=f.add('photo.png',png),voice=f.add('voice.wav',Buffer.from('RIFF0000WAVEsynthetic'));
  const dependencies={attachments:f.attachments,audio:{prepare(){throw Error('MUST_NOT_RUN');}},uploadFile(){throw Error('MUST_NOT_RUN');}};
  const request={id:'bad',text:'',attachments:[voice,{...image,sha256:'a'.repeat(64)}]};
  assert.match((await prepareAttachments(request,dependencies)).failure,/完整性校验失败/);
  const failed=await prepareAttachments({...request,attachments:[voice,image]},{...dependencies,audio:{prepare:async()=>({failure:'ASR_FAILED'})}});assert.deepEqual(failed,{failure:'ASR_FAILED'});
});
test('超过原生图片限额时在转写、编码和模型调用前明确拒绝，原件继续保存',async t=>{
  const f=fixture(t),image=f.add('photo.png',png),request={id:'limit',text:'',attachments:[image]};
  const result=await prepareAttachments(request,{attachments:f.attachments,imageLimits:{maxImagesPerMessage:8,maxImageBytes:png.length-1,maxMessageImageBytes:1000},audio:{prepare(){throw Error('MUST_NOT_RUN');}},uploadFile(){throw Error('MUST_NOT_RUN');}});
  assert.match(result.failure,/大小限制/);assert.equal(f.attachments.verify(image.id).sha256,image.sha256);
});
test('动图的模型输入携带时序选帧证据，原始GIF引用保留且损坏校验先于转换',async t=>{
  const f=fixture(t),bytes=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7','base64'),gif=f.add('wave.gif',bytes);let calls=0;
  const options={attachments:f.attachments,previewGif:async original=>{calls++;assert.deepEqual(original,bytes);return {data:png,mediaType:'image/png',totalFrames:20,frameCount:12,durationMs:1200,frames:[{index:0,timeMs:0},{index:19,timeMs:1140}]};}};
  const result=await prepareAttachments({id:'gif',text:'',attachments:[gif]},options);assert.match(result.promptContent[1].text,/时序选帧/);assert.match(result.promptContent[1].text,/共 20 帧/);assert.equal(result.animationViews[0].attachmentId,gif.id);assert.equal(result.animationViews[0].frameCount,12);assert.equal(result.promptContent[2].mediaType,'image/png');assert.equal(result.promptContent[2].data,png.toString('base64'));assert.equal(calls,1);assert.deepEqual(fs.readFileSync(f.attachments.verify(gif.id).file),bytes);
  assert.match((await prepareAttachments({id:'bad-gif',attachments:[{...gif,sha256:'0'.repeat(64)}]},options)).failure,/完整性/);assert.equal(calls,1);
});
test('图片与文件的持久引用经过窗口重建、重开与模型投影后仍保留，旧文字窗口兼容',async t=>{
  const f=fixture(t),image={type:'image',attachment:{attachmentId:'native-image',mediaType:'image/png',bytes:png.length,width:1,height:1,name:'photo.png'}},file={type:'file',attachment:{attachmentId:'native-file',name:'课程.pdf',bytes:30}};
  const events=[{seq:1,time:1,type:'user/message',surfaceOp:'append',data:{source:{kind:'user'},content:[image,file]}}];
  const rows=chatRecords(events,'chat');assert.equal(rows.length,1);assert.deepEqual(rows[0].attachments,[image,file]);
  assert.equal(recentWindow(rows,[],{recentWindowMessages:4,recentWindowTokens:2000}).length,1);
  const agent={session:{id:'chat',surface:{nodes:[]},snapshotEvents:()=>events}};
  const window=createChatWindow(agent,()=>({records:[]}),{root:f.root});
  const projected=projectWindowMessage(await window.prepare());assert.deepEqual(projected.find(m=>m.role==='user').content.slice(1),[image,file]);
  const reopened=createChatWindow(agent,()=>({records:[]}),{root:f.root});assert.deepEqual(projectWindowMessage(await reopened.prepare()).find(m=>m.role==='user').content.slice(1),[image,file]);
});
