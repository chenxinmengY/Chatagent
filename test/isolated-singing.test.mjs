import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { importSingingResult, createIsolatedSingingWorker, verifySingingInstallation } from '../packages/companion-capabilities/isolated-singing.mjs';
import { fileSha } from '../packages/companion-capabilities/vendor/singing/common.mjs';
import { wav } from '../packages/companion-capabilities/media.mjs';
import { verifyInstallationFiles } from '../packages/companion-capabilities/installation-integrity.mjs';

function fixture(t) {
  const parent = path.resolve('.verification-tmp'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'singing-import-'));
  t.after(() => { if (path.dirname(fs.realpathSync(root)) !== fs.realpathSync(parent)) throw Error('CLEANUP_REFUSED'); fs.rmSync(root, { recursive: true }); });
  const runtimeDirectory = path.join(root, 'worker'), outputRoot = path.join(root, 'capabilities'), id = 'song-test';
  const dir = path.join(runtimeDirectory, 'jobs', id); fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(outputRoot);
  const file = path.join(dir, 'master.wav'); fs.writeFileSync(file, wav(Buffer.alloc(48000)));
  return { root, runtimeDirectory, outputRoot, id, mode: 'whole', result: { master: { path: file, sha256: fileSha(file), frames: 24000 } } };
}
test('真实唱歌适配只导入当前任务的已校验母带，不覆写或接受其他任务文件', t => {
  const f = fixture(t), result = importSingingResult(f);
  assert.equal(fileSha(result.master.path), f.result.master.sha256); assert.ok(result.master.path.startsWith(f.outputRoot + path.sep));
  assert.throws(() => importSingingResult(f), /EEXIST/);
  assert.throws(() => importSingingResult({ ...f, id: 'another-task' }), /OUTSIDE_ROOT/);
  assert.throws(() => importSingingResult({ ...f, id: '../escape' }), /JOB_ID/);
});
test('唱歌输出损坏和片段清单错配必须拒绝，不能将未知音频发布', t => {
  const f = fixture(t); fs.appendFileSync(f.result.master.path, 'changed');
  assert.throws(() => importSingingResult(f), /MASTER_CHANGED/); assert.deepEqual(fs.readdirSync(f.outputRoot), []);
  f.result.master.sha256 = fileSha(f.result.master.path);
  const manifest = path.join(path.dirname(f.result.master.path), 'segments.json'); fs.writeFileSync(manifest, JSON.stringify({ ok: false }));
  assert.throws(() => importSingingResult({ ...f, mode: 'clip', result: { ...f.result, segmentsManifest: manifest, segmentsManifestSha256: fileSha(manifest) } }), /SEGMENTS_INVALID/);
});
test('独立唱歌默认不启动进程，缺少安装清单和关闭后均不能运行', async t => {
  const f = fixture(t), worker = createIsolatedSingingWorker({ root: f.root, outputRoot: f.outputRoot });
  assert.equal(worker.state, 'idle'); assert.equal(worker.runtimeDirectory, undefined);
  assert.throws(() => verifySingingInstallation('relative'), /ASCII_ROOT_REQUIRED/);
  await worker.close(); assert.equal(worker.ready, false); await assert.rejects(worker.start(), /PROVIDER_CLOSED/);
});
test('安装全量校验拒绝同长度字节改变、重复路径、越界和目录链接', t => {
  const f = fixture(t), file = f.result.master.path;
  const pin = { file: path.relative(f.root, file).replaceAll('\\', '/'), bytes: fs.statSync(file).size, sha256: fileSha(file) };
  assert.ok(verifyInstallationFiles(f.root, [pin]).has(pin.file));
  assert.throws(() => verifyInstallationFiles(f.root, [pin, pin]), /INSTALLATION_PATH/);
  assert.throws(() => verifyInstallationFiles(f.root, [{ ...pin, file: '../outside' }]), /INSTALLATION_PATH/);
  const bytes = fs.readFileSync(file); bytes[100] ^= 1; fs.writeFileSync(file, bytes);
  assert.throws(() => verifyInstallationFiles(f.root, [pin]), /INSTALLATION_CHANGED/);
  const link = path.join(f.root, 'link'); fs.symlinkSync(path.dirname(file), link, process.platform === 'win32' ? 'junction' : 'dir');
  try { assert.throws(() => verifyInstallationFiles(f.root, [{ ...pin, file: 'link/master.wav', sha256: fileSha(file) }]), /LINK/); }
  finally { fs.unlinkSync(link); }
});
