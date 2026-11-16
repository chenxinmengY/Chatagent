import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connect } from '../packages/dsh-bridge/local-media.mjs';
import { sandbox } from './helpers.mjs';

async function fixture(root) {
  fs.mkdirSync(root); let context, disposed = false;
  const tools=new Map();
  const agent = { session: { id: 'synthetic-chat' }, ctx: { tools:{register(value){tools.set(value.name,value);return ()=>tools.delete(value.name);}},systemPrompt: { context(value) { context = value; return () => { disposed = true; }; } } } };
  const media = await connect({ agent, root, config: { attachmentsRoot: path.join(root, 'attachments'), asrRoot: path.join(root, 'unused-asr') }, publish() {}, lookup() {} });
  const db = new DatabaseSync(path.join(root, 'audio.sqlite'));
  assert.equal(tools.has('chatagent_send_voice'),true);
  return { media, db, text: () => context?.text() ?? '', disposed: () => disposed, async close() { db.close(); await media.close();assert.equal(tools.size,0); } };
}

test('语音后的文字追问保留已收到和已转写的证据，原音不可用不推翻转写', async t => {
  const closers = []; t.after(async () => { for (const f of closers) await f.close(); });
  const { root } = sandbox(t), f = await fixture(path.join(root, 'voice-chat')); closers.push(f);
  f.db.prepare("INSERT INTO audio_inputs VALUES('voice-1','synthetic','completed',?,NULL)").run('喂喂喂，听得到我说话吗？');
  await f.media.before({ id: 'voice-1', audioTranscription: true });
  assert.match(f.text(), /本轮语音已收到并完成本地转写/); assert.match(f.text(), /喂喂喂，听得到我说话吗/);
  f.media.after(); assert.equal(f.text(), '');
  await f.media.before({ id: 'text-followup' });
  assert.match(f.text(), /本轮没有新的语音附件/); assert.match(f.text(), /"requestId":"voice-1","state":"completed"/);
  assert.match(f.text(), /喂喂喂，听得到我说话吗/); assert.match(f.text(), /不证明听过原始声线/); assert.match(f.text(), /不能据此否定上一条语音已收到/);
  assert.deepEqual(f.db.prepare('SELECT state,text FROM audio_inputs').get(), Object.assign(Object.create(null), { state: 'completed', text: '喂喂喂，听得到我说话吗？' }));
  await closers.pop().close(); assert.equal(f.disposed(), true);
});

test('语音状态不跨聊天或主动消息泄漏，失败与未知结果不编造转写', async t => {
  const closers = []; t.after(async () => { for (const f of closers) await f.close(); });
  const { root } = sandbox(t), a = await fixture(path.join(root, 'a')), b = await fixture(path.join(root, 'b')); closers.push(a, b);
  a.db.prepare("INSERT INTO audio_inputs VALUES('old','synthetic','completed','PRIVATE_TRANSCRIPT',NULL)").run();
  await b.media.before({ id: 'other-chat' }); assert.equal(b.text(), '');
  await a.media.before({ id: 'proactive', proactive: true }); assert.equal(a.text(), '');
  for (const state of ['failed', 'unknown']) {
    a.db.prepare('INSERT INTO audio_inputs VALUES(?,?,?,NULL,NULL)').run(state, 'synthetic', state);
    await a.media.before({ id: 'text-' + state });
    assert.match(a.text(), new RegExp('"state":"' + state + '"')); assert.doesNotMatch(a.text(), /PRIVATE_TRANSCRIPT|"transcript":|本轮语音已收到并完成/);
  }
});
