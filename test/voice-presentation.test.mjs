import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {hiddenVoiceNotice, displayedText} from '../apps/web/message-presentation.js';
import {sandbox} from './helpers.mjs';

test('旧语音处理中/转写仅按来源隐藏，不误隐藏用户同文、失败提示或普通回复',()=>{
 for(const prefix of ['asr-start-','asr-text-']){
  assert.equal(hiddenVoiceNotice({device:'plugin-delivery',client_id:prefix+'test',text:'history'}),true);
  assert.equal(hiddenVoiceNotice({device:'phone',client_id:prefix+'test',text:'history'}),false);
 }
 assert.equal(hiddenVoiceNotice({device:'plugin-delivery',client_id:'notice-voice-x',text:'失败'}),false);
 assert.equal(hiddenVoiceNotice({role:'assistant',text:'语音已保存，正在转写。'}),false);
 const delivery={device:'plugin-delivery',client_id:'voice-'+'a'.repeat(40)+'-0',text:'语音回复 1/1（电脑已保存）',attachments:[{mediaType:'audio/wav'}]};
 assert.equal(displayedText(delivery),'');assert.equal(displayedText({...delivery,device:'phone'}),delivery.text);
 assert.equal(displayedText({...delivery,attachments:[]}),delivery.text);
 const song={...delivery,client_id:'b'.repeat(64),text:'整首翻唱（电脑已保存）'};assert.equal(displayedText(song),'');assert.equal(displayedText({...song,device:'phone'}),song.text);assert.equal(displayedText({...song,text:'生成失败'}),'生成失败');
});

test('Android历史与当前消息使用相同来源过滤，用户文字和错误不受影响',t=>{
 const {root}=sandbox(t),java=process.env.CHATAGENT_JDK??'C:/Program Files/Java/jdk-17';
 fs.writeFileSync(path.join(root,'PresentationCheck.java'),`import local.chatagent.privatechat.MessagePresentation; public class PresentationCheck {static void check(boolean b){if(!b)throw new AssertionError();}public static void main(String[] args){check(MessagePresentation.hidden("plugin-delivery","asr-start-1"));check(MessagePresentation.hidden("plugin-delivery","asr-text-1"));check(!MessagePresentation.hidden("phone","asr-text-1"));check(!MessagePresentation.hidden("plugin-delivery","notice-voice-1"));check(MessagePresentation.voiceCaption("plugin-delivery","voice-${'a'.repeat(40)}-0"));check(!MessagePresentation.voiceCaption("phone","voice-${'a'.repeat(40)}-0"));check(MessagePresentation.voiceCaption("plugin-delivery","${"b".repeat(64)}","整首翻唱（电脑已保存）"));check(!MessagePresentation.voiceCaption("plugin-delivery","${"b".repeat(64)}","生成失败"));System.out.println("presentation passed");}}`);
 execFileSync(path.join(java,'bin/javac.exe'),['-encoding','UTF-8','-d',root,path.resolve('apps/android/src/local/chatagent/privatechat/MessagePresentation.java'),path.join(root,'PresentationCheck.java')]);
 assert.match(execFileSync(path.join(java,'bin/java.exe'),['-cp',root,'PresentationCheck'],{encoding:'utf8'}),/presentation passed/);
});
