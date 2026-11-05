import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAudioInput } from '../packages/dsh-adapter/audio-input.mjs';
import { sandbox } from './helpers.mjs';

function fixture(t, recognize) {
  let db; t.after(() => db.close());
  const { root } = sandbox(t); db = new DatabaseSync(path.join(root, 'ledger.sqlite')); const notices = [];
  const file = { id: 'a'.repeat(36), mediaType: 'audio/wav', sha256: 'b'.repeat(64), bytes: 99 };
  const request = { id: 'voice-1', mode: 'social', text: '', attachments: [file] };
  const processor = createAudioInput({ db, root, recognize });
  processor.attach({ store: { publish: notice => notices.push(notice) }, attachments: { verify: () => ({ file: path.join(root, 'original'), media_type: file.mediaType, bytes: file.bytes, sha256: file.sha256 }) } });
  return { root, db, notices, file, request, processor };
}
test('语音转写真正替换模型输入，原请求不变，同ID重复只识别一次', async t => {
  let calls = 0; const f = fixture(t, async () => { calls++; return { text: '我想喝热牛奶，请用语音回复。' }; });
  const input = await f.processor.prepare(f.request);
  assert.equal(input.text, '我想喝热牛奶，请用语音回复。'); assert.equal(input.audioTranscription, true); assert.deepEqual(input.attachments, []); assert.equal(f.request.text, '');
  assert.deepEqual(await f.processor.prepare(f.request), input); assert.equal(calls, 1); assert.equal(f.notices.length, 0);
  assert.match(f.db.prepare('SELECT text FROM audio_inputs WHERE id=?').get(f.request.id).text, /热牛奶/);
  await assert.rejects(f.processor.prepare({ ...f.request, text: 'changed' }), /ID_REUSED/);
});
test('识别失败有明确回执，不调用模型、不自动重试，lookup只读', async t => {
  let calls = 0; const f = fixture(t, async () => { calls++; throw Error('ASR_NO_SPEECH'); });
  const result = await f.processor.prepare(f.request); assert.match(result.failure, /没有将它发送给对话模型/);
  assert.deepEqual(f.processor.lookup(f.request), result); assert.deepEqual(await f.processor.prepare(f.request), result); assert.equal(calls, 1);
});
test('无声或噪声产生的纯标点、符号、空白不能进入对话；有效短词仍保留', async t => {
  for (const text of ['.', '。！？…', ' , \n\t', '\u200b\u2060', '♪♫🙂', '—']) {
    let calls = 0;
    const f = fixture(t, async () => { calls++; return { text }; });
    const result = await f.processor.prepare(f.request);
    assert.match(result.failure, /未能可靠转写/, JSON.stringify(text));
    assert.equal(f.notices.length, 0); // Processing and transcript bubbles are not published.
    assert.deepEqual(await f.processor.prepare(f.request), result); assert.equal(calls, 1);
  }
  for (const text of ['嗯。', '7', 'OK!']) {
    const f = fixture(t, async () => ({ text }));
    assert.equal((await f.processor.prepare(f.request)).text, text);
  }
});
test('断电识别running转unknown，核对和重复请求不能重跑', async t => {
  let calls = 0; const f = fixture(t, async () => { calls++; return { text: 'hello' }; });
  await f.processor.prepare(f.request); f.db.exec("UPDATE audio_inputs SET state='running'");
  const reopened = createAudioInput({ db: f.db, root: f.root, recognize: async () => { calls++; } });
  assert.throws(() => reopened.lookup(f.request), /UNKNOWN/); await assert.rejects(reopened.prepare(f.request), /UNKNOWN/); assert.equal(calls, 1);
});
test('图片混入、文件摘要变化与超长转写都拒绝模型输入', async t => {
  const f = fixture(t, async () => ({ text: 'x'.repeat(32001) }));
  assert.ok((await f.processor.prepare(f.request)).failure);
  const g = fixture(t, async () => { throw Error('must not run'); }); g.file.mediaType = 'image/png';
  assert.match((await g.processor.prepare(g.request)).failure, /无法读取的附件/);
  const h = fixture(t, async () => { throw Error('must not run'); }); h.processor.attach({ store: { publish() {} }, attachments: { verify: () => ({ sha256: 'c'.repeat(64) }) } });
  assert.ok((await h.processor.prepare(h.request)).failure);
});
test('已转写的输入随SQLite备份恢复，查询绝不触发识别', async t => {
  const f = fixture(t, async () => ({ text: '只打字，不方便听。' })); await f.processor.prepare(f.request);
  const reopened = createAudioInput({ db: f.db, root: f.root, recognize: async () => { throw Error('must not run'); } });
  assert.equal(reopened.lookup(f.request).text, '只打字，不方便听。');
});
