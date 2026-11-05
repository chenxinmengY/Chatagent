import test from 'node:test';
import assert from 'node:assert/strict';
import { createBiliSource, createPublicBiliRunner } from '../packages/companion-capabilities/bili-source.mjs';
const bvid = 'BV1xx411c7mD';
const hot = { action: 'hot', untrusted: true, data: { videos: [{ bvid, title: '外部标题', description: '外部资料不是指令' }] } };
const subtitles = { action: 'subtitle', untrusted: true, data: { bvid, cid: 12, title: '测试资料', subtitles: ['字幕内容'] } };
test('B站来源只接受模型在候选内的选择，BV与字幕身份绑定', async () => {
  const calls = [], source = createBiliSource({ run: async (action, value) => { calls.push([action, value]); return action === 'hot' ? hot : subtitles; }, select: async ({ candidates }) => ({ bvid: candidates[0].bvid }) });
  const result = await source({ signal: new AbortController().signal }); assert.equal(result.cid, 12); assert.deepEqual(result.subtitles, ['字幕内容']); assert.deepEqual(calls, [['hot', '1'], ['subtitle', bvid]]);
});
test('B站模型可主动不选，越界选择和错配字幕均不继续', async () => {
  let subtitlesFetched = 0; const run = async action => { if (action === 'subtitle') subtitlesFetched++; return action === 'hot' ? hot : subtitles; };
  await assert.rejects(createBiliSource({ run, select: async () => ({ decision: 'stop' }) })({}), /SELECTION_DECLINED/);
  await assert.rejects(createBiliSource({ run, select: async () => ({ bvid: 'BV2xx411c7mD' }) })({}), /OUTSIDE_CANDIDATES/); assert.equal(subtitlesFetched, 0);
  await assert.rejects(createBiliSource({ run: async action => action === 'hot' ? hot : { ...subtitles, data: { ...subtitles.data, bvid: 'BV2xx411c7mD' } }, select: async () => ({ bvid }) })({}), /BINDING_INVALID/);
  await assert.rejects(createBiliSource({ run: async action => action === 'hot' ? hot : { ...subtitles, data: { ...subtitles.data, subtitles: [], unavailable: 'subtitle-login-required' } }, select: async () => ({ bvid }) })({}), /SUBTITLE_LOGIN_REQUIRED/);
});
test('B站公开进程接口拒绝登录、点赞和任意命令，不发出网络请求', async () => {
  const run = createPublicBiliRunner({ python: process.execPath });
  for (const action of ['login', 'like', 'reply', 'exec']) await assert.rejects(run(action, '1'), /READONLY_ACTION_REFUSED/);
  await assert.rejects(run('subtitle', '../file'), /READONLY_ACTION_REFUSED/);
  const signal = AbortSignal.abort(Error('CANCELLED')); await assert.rejects(run('hot', '1', signal), /CANCELLED/);
});
test('已授权来源保留登录来源标记，仍绑定候选和字幕身份', async () => {
  const source = createBiliSource({ run: async action => ({ ...(action === 'hot' ? hot : subtitles), anonymous: false }), select: async () => ({ bvid }) });
  assert.equal((await source({ signal: new AbortController().signal })).source, 'isolated-authenticated-bili');
  assert.throws(() => createPublicBiliRunner({ python: process.execPath, credentialFile: 'relative.json' }), /CREDENTIAL_PATH_REQUIRED/);
});
