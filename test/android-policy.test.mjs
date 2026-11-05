import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { sandbox } from './helpers.mjs';
import { outboxAction } from '../apps/web/outbox.js';

test('实际Android Java待发策略与桌面端在时钟、30分钟、模式和档案变化上保持一致', t => {
  const box = sandbox(t), javaRoot = process.env.CHATAGENT_JDK ?? 'C:/Program Files/Java/jdk-17';
  const cases = [];
  for (const elapsed of [-1, 0, 1, 1799999, 1800000, 1800001, 86400000]) for (const confirmed of [0, 1001, 900, 999999999]) for (const epoch of ['epoch', 'old']) for (const revision of [0, 1]) {
    cases.push({ now: 1000 + elapsed, queued: 1000, confirmed, epoch, revision });
  }
  fs.writeFileSync(path.join(box.root, 'PolicyCheck.java'), `import local.chatagent.privatechat.QueuePolicy; import java.io.*;
public class PolicyCheck { public static void main(String[] args)throws Exception {BufferedReader in=new BufferedReader(new InputStreamReader(System.in));String line;while((line=in.readLine())!=null){String[] p=line.split(",");System.out.println(QueuePolicy.action(Long.parseLong(p[0]),Long.parseLong(p[1]),Long.parseLong(p[2]),p[3],"epoch","social","social",Long.parseLong(p[4]),0,"queued"));}}}`);
  execFileSync(path.join(javaRoot, 'bin/javac.exe'), ['-encoding', 'UTF-8', '-d', box.root, path.resolve('apps/android/src/local/chatagent/privatechat/QueuePolicy.java'), path.join(box.root, 'PolicyCheck.java')]);
  const results = execFileSync(path.join(javaRoot, 'bin/java.exe'), ['-cp', box.root, 'PolicyCheck'], { input: cases.map(item => [item.now,item.queued,item.confirmed,item.epoch,item.revision].join(',')).join('\n'), encoding: 'utf8' }).trim().split(/\r?\n/);
  for (let i=0;i<cases.length;i++) { const value=cases[i]; const desktop=outboxAction({ queuedAt:value.queued, ...(value.confirmed?{confirmedAt:value.confirmed}:{}),epoch:value.epoch,expectedMode:'social',expectedModeRevision:value.revision },'epoch',value.now,{mode:'social',modeRevision:0}); assert.equal(results[i]==='send',['submit','submit_and_confirm'].includes(desktop),JSON.stringify(value)); }
  assert.equal(results.length, 112);
});
