import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox } from './helpers.mjs';
test('实际Java按住说话：松手只发送一次、上滑取消、移回继续、系统中断与未授权不发送', t => {
 const { root }=sandbox(t),java=process.env.CHATAGENT_JDK??'C:/Program Files/Java/jdk-17';
 fs.writeFileSync(path.join(root,'HoldCheck.java'),`import local.chatagent.privatechat.HoldToTalk;
 public class HoldCheck {static void check(boolean x){if(!x)throw new AssertionError();}public static void main(String[] args){
 HoldToTalk h=new HoldToTalk();check(!h.finish());check(h.begin(500));check(!h.begin(500));check(h.finish());check(!h.finish());
 h.begin(500);h.move(436,64);check(h.cancelling());check(!h.finish());
 h.begin(500);h.move(420,64);h.move(480,64);check(!h.cancelling());check(h.finish());
 h.begin(500);h.cancel();check(!h.finish());h.cancel();check(!h.finish());
 h.begin(500);h.move(600,64);check(h.finish());System.out.println("hold gestures passed");}}
 `);
 execFileSync(path.join(java,'bin/javac.exe'),['-encoding','UTF-8','-d',root,path.resolve('apps/android/src/local/chatagent/privatechat/HoldToTalk.java'),path.join(root,'HoldCheck.java')]);
 assert.match(execFileSync(path.join(java,'bin/java.exe'),['-cp',root,'HoldCheck'],{encoding:'utf8'}),/hold gestures passed/);
});
