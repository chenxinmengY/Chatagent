import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCapabilityHost, splitSpeech } from '../packages/companion-capabilities/host.mjs';
import { wav, verifyAudio } from '../packages/companion-capabilities/media.mjs';
import { sha, fileSha } from '../packages/companion-capabilities/vendor/singing/common.mjs';
import { encode } from '../packages/companion-capabilities/vendor/silk-wasm/lib/index.mjs';
import { ChatStore } from '../packages/conversation/store.mjs';
import { AttachmentStore } from '../packages/storage/attachments.mjs';
import { startService } from '../apps/service/server.mjs';

const base = path.resolve('.verification-tmp'); fs.mkdirSync(base, { recursive: true });
const capsule = { account: 'a'.repeat(64), personaDigest: 'b'.repeat(64), key: 'wechat:private:12345' };
export function tone(sampleRate = 24000, seconds = 1) { const pcm = Buffer.alloc(sampleRate * seconds * 2); for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i / sampleRate * 440 * Math.PI * 2) * 1000), i * 2); return wav(pcm, sampleRate); }
async function fixture(t, providers = {}) {
  const root = fs.mkdtempSync(path.join(base, 'capabilities-')), capabilityRoot = path.join(root, 'capability');
  const store = new ChatStore(path.join(root, 'chat.sqlite')), attachments = new AttachmentStore(path.join(root, 'attachments'));
  const host = createCapabilityHost({ root: capabilityRoot, capsule, providers }); host.attachDelivery({ store, attachments });
  t.after(async () => { await host.close(); attachments.close(); store.close(); });
  return { root, capabilityRoot, host, store, attachments };
}
const request = (id, text, mode = 'social') => ({ id, text, mode });
const run = async (host, req, reply = '本地演练的合成文字。') => { await host.beforeTurn(req); host.afterTurn(); await host.afterReply(req, reply); };
const messages = store => store.db.prepare("SELECT * FROM messages WHERE device='plugin-delivery'").all().map(r => store.hydrate(r));
const synth = async ({ directory, id }) => { const file = path.join(directory, id + '.wav'); fs.writeFileSync(file, tone()); return { file, sha256: fileSha(file) }; };
const biliSource = async () => ({ bvid: 'BV1xx411c7mD', cid: 1, title: '本地字幕演练', subtitles: ['字幕是本地测试资料，不是线上浏览。'.repeat(80)] });

test('能力默认关闭独立模型，不连接生产地址；相同身份可恢复，跨人格拒绝', async t => {
  const { host, capabilityRoot } = await fixture(t);
  assert.deepEqual(host.status().ready, { singing: false, voice: false, bili: false });
  await run(host, request('bili-off', '你去刷一会B站吧'));
  assert.equal(host.status().jobs.find(j => j.kind === 'bili').state, 'unavailable');
  assert.throws(() => createCapabilityHost({ root: capabilityRoot, capsule: { ...capsule, personaDigest: 'c'.repeat(64) } }), /SCOPE_CHANGED/);
});
test('原B站邀请规则排除转述、引用、疑问、否定、假设；当前邀请一次入账', async t => {
  const { host } = await fixture(t, { biliSource, biliRead: async () => '测试感受' });
  for (const [i, text] of ['你去刷B站了吗？', '不要刷B站', '如果你去刷B站吧', '她说你去刷B站吧', '“你去刷B站吧”', '引用：你去刷B站吧'].entries()) await host.beforeTurn(request('negative-' + i, text));
  assert.equal(host.status().jobs.length, 0);
  const req = request('bili-once', '你去刷一会B站吧'); await run(host, req); await run(host, req);
  const job = host.status().jobs.find(j => j.kind === 'bili');
  assert.equal(job.state, 'completed'); assert.equal(job.detail.pages, 2); assert.equal(job.detail.originalAudio, false); assert.equal(host.archive().length, 1);
});
test('B站抽帧哈希和图像能力校验，回调真正取得图像字节', async t => {
  let imagesRead = 0;
  const reader = async ({ images }) => { imagesRead += images.length; return '仅看到了本地示例画面'; }; reader.supportsImages = true;
  const source = async ({ directory }) => { const file = path.join(directory, 'frame.png'); fs.writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUioAAAAASUVORK5CYII=', 'base64')); return { ...await biliSource(), subtitles: [], frames: [{ file, sha256: fileSha(file), at: 0 }] }; };
  const f = await fixture(t, { biliSource: source, biliRead: reader }); await run(f.host, request('visual', '去刷B站吧'));
  assert.equal(imagesRead, 1); assert.equal(f.host.status().jobs.find(j => j.kind === 'bili').detail.kind, 'sampled-frames');
  const bad = await fixture(t, { biliSource: async opts => { const bundle = await source(opts); bundle.frames[0].sha256 = '0'.repeat(64); return bundle; }, biliRead: reader });
  await run(bad.host, request('bad-frame', '去刷B站吧')); assert.equal(imagesRead, 1); assert.equal(bad.host.archive().length, 0);
});
test('B站中途失败保留已读页，不归档完整感受、不自动重跑', async t => {
  let calls = 0; const { host } = await fixture(t, { biliSource, biliRead: async () => { if (++calls === 2) throw Error('MODEL_UNAVAILABLE'); return '第一页测试'; } });
  const req = request('bili-error', '去刷B站吧'); await run(host, req); await run(host, req);
  const job = host.status().jobs.find(j => j.kind === 'bili'); assert.equal(calls, 2); assert.equal(job.state, 'failed'); assert.equal(job.detail.pages, 1); assert.equal(host.archive().length, 0);
});
test('自动语音使用原上下文意图模型接口，真实音频解码、哈希和重复请求去重', async t => {
  let judgments = 0, generations = 0;
  const { host, store, attachments } = await fixture(t, { voiceIntent: async ({ context }) => { judgments++; assert.equal(context.messages.at(-1).text, '想听你说话'); return '{"speak":true}'; }, voiceSynthesize: async args => { generations++; return synth(args); } });
  const req = request('voice-once', '想听你说话'); await run(host, req); await run(host, req);
  assert.equal(judgments, 1); assert.equal(generations, 1); const rows = messages(store); assert.equal(rows.length, 1);
  const file = attachments.verify(rows[0].attachments[0].id); assert.equal(file.media_type, 'audio/wav'); await verifyAudio(file.file); assert.equal(host.status().jobs[0].state, 'completed');
});
test('只打字、唱歌、引用与助手模式不能被肯定意图模型误开普通语音', async t => {
  let calls = 0; const { host, store } = await fixture(t, { voiceIntent: async () => { calls++; return '{"speak":true}'; }, voiceSynthesize: synth });
  for (const [i, text] of ['只打字', '不方便听', '想听你唱这首', '引用“想听你说话”', '如果我想听你说话'].entries()) await run(host, request('veto-' + i, text));
  await run(host, request('assistant', '想听你说话', 'assistant')); assert.equal(calls, 0); assert.equal(messages(store).length, 0);
});
test('意图模型缺失/非法结果不猜关键词；合成损坏保留文字且不发布音频', async t => {
  let generations = 0; const f = await fixture(t, { voiceIntent: async () => 'yes', voiceSynthesize: async args => { generations++; return synth(args); } });
  await run(f.host, request('bad-intent', '想听你说话')); assert.equal(generations, 0); assert.match(messages(f.store)[0].text, /语音意图未能确认/);
  assert.deepEqual(f.host.status().jobs[0].detail.diagnostic, { error: 'VOICE_INTENT_RESPONSE_INVALID' });
  const g = await fixture(t, { voiceIntent: async () => '{"speak":true}', voiceSynthesize: async ({ directory }) => { const file = path.join(directory, 'bad.wav'); fs.writeFileSync(file, 'broken audio'); return { file, sha256: fileSha(file) }; } });
  await run(g.host, request('bad-audio', '想听你说话')); assert.equal(messages(g.store).filter(m => m.attachments.length).length, 0); assert.equal(g.host.status().jobs[0].state, 'failed');
});
test('自然断句不截断Unicode字符，多段语音全部验证后发布', async t => {
  const text = '今天🙂我们慢慢说。'.repeat(70), parts = splitSpeech(text);
  assert.equal(parts.join(''), text); assert.ok(parts.every(s => s.isWellFormed() && Array.from(s).length <= 220));
  const { host, store } = await fixture(t, { voiceIntent: async () => '{"speak":true}', voiceSynthesize: synth }); await run(host, request('long-voice', '想听你说话'), text);
  assert.equal(messages(store).filter(m => m.attachments.length).length, parts.length);
});
test('合成语速导致超长时重新按句拆分，取消意图判断后不得合成', async t => {
  let calls = 0;
  const f = await fixture(t, { voiceIntent: async () => '{"speak":true}', voiceSynthesize: async ({ directory, id }) => { const file = path.join(directory, id + '.wav'); fs.writeFileSync(file, tone(24000, ++calls === 1 ? 59 : 1)); return { file, sha256: fileSha(file) }; } });
  await run(f.host, request('slow', '想听你说话'), '第一句话。第二句话。'); assert.equal(calls, 3); assert.equal(messages(f.store).filter(m => m.attachments.length).length, 2);
  let release, entered, made = 0; const started = new Promise(r => { entered = r; });
  const g = await fixture(t, { voiceIntent: async () => { entered(); await new Promise(r => { release = r; }); return '{"speak":true}'; }, voiceSynthesize: async args => { made++; return synth(args); } });
  const pending = run(g.host, request('cancel-intent', '想听你说话')); await started; g.host.cancel(); release(); await pending; assert.equal(made, 0); assert.equal(g.host.status().jobs[0].state, 'cancelled');
});
async function singingFixture(t, { corrupt = false } = {}) {
  let work = 0, hostRoot;
  const source = { peek: bvid => ({ identity: { bvid, revision: 'local-tone' } }), resolve: async req => ({ identity: { bvid: req.bvid, revision: 'local-tone' }, title: '本地测试音，不是小鲸鱼声线' }), prepare: async () => { const file = path.join(hostRoot, 'input.wav'); fs.writeFileSync(file, tone(44100, 2)); return { path: file, sha256: fileSha(file) }; } };
  const worker = { ready: true, state: 'ready', close: async () => {}, async run({ id, inputPath, inputSha256, mode }) {
    work++; assert.equal(fileSha(inputPath), inputSha256);
    if (mode === 'whole') return { master: { path: inputPath, sha256: inputSha256, frames: 88200 } };
    const directory = path.join(hostRoot, id); fs.mkdirSync(directory); const encoded = await encode(fs.readFileSync(inputPath), 0), file = path.join(directory, 'part-01.silk'); fs.writeFileSync(file, encoded.data);
    const manifest = path.join(directory, 'segments.json'); fs.writeFileSync(manifest, JSON.stringify({ ok: true, sampleRate: 44100, sourceFrames: 88200, segments: [{ index: 1, startFrame: 0, endFrame: 88200, silk: 'part-01.silk', encoded: { sha256: corrupt ? '0'.repeat(64) : fileSha(file), bytes: encoded.data.length, durationMs: encoded.duration } }] })); return { segmentsManifest: manifest };
  } };
  const f = await fixture(t, { singingSource: source, singingWorker: worker, recipeDigest: sha('synthetic-audio-test') }); hostRoot = f.capabilityRoot;
  return { ...f, work: () => work };
}
async function sing(host, id, clip = false) { await host.beforeTurn(request(id, '给我唱 BV1xx411c7mD' + (clip ? ' 前2秒' : ' 整首'))); const result = await host.singingControl('sing'); await host.settled(); return result; }
test('原唱歌整首流程生成真实320kbps MP3、本地交付，缓存复用而非重新生成', async t => {
  const { host, store, attachments, work } = await singingFixture(t);
  assert.equal((await sing(host, 'whole')).status, 'submitted');
  assert.equal(host.singing.snapshot().jobs.at(-1).status, 'complete');
  const ref = messages(store)[0].attachments[0]; assert.equal(ref.mediaType, 'audio/mpeg'); await verifyAudio(attachments.verify(ref.id).file);
  await sing(host, 'whole-cache'); assert.equal(work(), 1); assert.equal(host.singing.snapshot().jobs.at(-1).cacheHit, true);
  await sing(host, 'whole-cache'); assert.equal(messages(store).length, 2);
});
test('原SILK片段校验后实际解码WAV，损坏的片段清单不能发布音频', async t => {
  const good = await singingFixture(t); await sing(good.host, 'clip', true); assert.equal(good.host.singing.snapshot().jobs.at(-1).status, 'complete'); assert.equal(messages(good.store)[0].attachments[0].mediaType, 'audio/wav');
  const bad = await singingFixture(t, { corrupt: true }); await sing(bad.host, 'bad-clip', true); assert.equal(bad.host.singing.snapshot().jobs.at(-1).status, 'error'); assert.equal(messages(bad.store).filter(m => m.attachments.length).length, 0);
});
test('唱歌发送响应丢失保留unknown，重启不生成、不补发；只读核对已有交付', async t => {
  const f = await singingFixture(t), publish = f.store.publish.bind(f.store);
  f.store.publish = value => { const result = publish(value); if (value.attachments?.length) throw Error('LOST_RESPONSE'); return result; };
  await sing(f.host, 'unknown'); assert.equal(f.host.singing.snapshot().jobs.at(-1).status, 'unknown'); const before = messages(f.store).length, work = f.work();
  await f.host.close(); f.store.publish = publish;
  const restarted = createCapabilityHost({ root: f.capabilityRoot, capsule }); restarted.attachDelivery({ store: f.store, attachments: f.attachments }); t.after(() => restarted.close());
  assert.equal(messages(f.store).length, before); assert.equal(f.work(), work); assert.equal(restarted.singing.snapshot().jobs.at(-1).status, 'unknown');
  const part = restarted.singing.snapshot().jobs.at(-1).parts[0]; assert.equal(restarted.media.reconcile(part.deliveryId).status, 'confirmed'); assert.equal(messages(f.store).length, before);
});
test('未知B站/语音轮次重启不自动执行；取消运行中的模型后不发布', async t => {
  let release, entered; const started = new Promise(r => { entered = r; });
  const f = await fixture(t, { biliSource, biliRead: async () => { entered(); await new Promise(r => { release = r; }); return '迟到的结果'; } });
  const pending = run(f.host, request('cancel-bili', '去刷B站吧')); await started; f.host.cancel(); release(); await pending;
  assert.equal(f.host.archive().length, 0); assert.equal(f.host.status().jobs.find(j => j.kind === 'bili').state, 'cancelled');
  await f.host.close(); const db = new DatabaseSync(path.join(f.capabilityRoot, 'jobs.sqlite')); db.prepare("UPDATE jobs SET state='running'").run(); db.close();
  const host = createCapabilityHost({ root: f.capabilityRoot, capsule }); t.after(() => host.close()); assert.ok(host.status().jobs.every(j => j.state === 'unknown'));
});
test('媒体越界、哈希冲突与交付ID复用拒绝；保存后崩溃可只读核对', async t => {
  const { host, root, store } = await fixture(t); const outside = path.join(root, 'outside.wav'); fs.writeFileSync(outside, tone());
  await assert.rejects(host.media.audio({ id: 'outside', file: outside, sha256: fileSha(outside), name: 'test.wav', text: '测试' }), /OUTSIDE_ROOT/);
  const file = path.join(host.root, 'inside.wav'); fs.writeFileSync(file, tone()); const args = { id: 'stable', file, sha256: fileSha(file), name: 'test.wav', text: '测试' };
  await host.media.audio(args); await host.media.audio(args); assert.equal(messages(store).length, 1);
  await assert.rejects(host.media.audio({ ...args, text: '更改正文' }), /CONFLICT/); await assert.rejects(host.media.audio({ ...args, id: 'hash', sha256: '0'.repeat(64) }), /CHANGED/);
});
test('HTTP文字已保存后媒体失败不改成unknown、不重跑模型', async t => {
  const root = fs.mkdtempSync(path.join(base, 'media-http-')); let calls = 0;
  const service = await startService({ dataRoot: path.join(root, 'chat'), port: 0, automaticBackups: false, backend: { reply: async () => { calls++; return '已保存的文字'; }, afterReply: async () => { throw Error('MEDIA_FAILED'); } } }); t.after(() => service.close());
  const row = service.store.submit({ deviceId: 'test', clientMessageId: 'one', text: '你好', queuedAt: Date.now(), expectedMode: 'social', expectedModeRevision: 0 }); await service.tick(); await service.tick(); assert.equal(service.store.message(row.id).state, 'completed'); assert.equal(calls, 1);
});
