import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AttachmentStore, verifyAttachmentSnapshot, MAX_ATTACHMENT_BYTES, MAX_CHUNK_BYTES } from '../packages/storage/attachments.mjs';
import { sandbox } from './helpers.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = (bytes, name = '合成附件.bin') => ({ name, bytes: bytes.length, sha256: hash(bytes) });

test('创建上传后元数据失败可认领同ID空文件，非空孤儿原件不能被截断', t => {
  const box = sandbox(t), store = new AttachmentStore(path.join(box.root, 'attachments'));
  try {
    const body = { ...metadata(Buffer.from('synthetic')), id: randomUUID() };
    store.db.exec("CREATE TRIGGER synthetic_create_fail BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT,'SYNTHETIC_CREATE_FAILURE'); END");
    assert.throws(() => store.create(body), /SYNTHETIC_CREATE_FAILURE/); assert.equal(store.count(), 0);
    store.db.exec('DROP TRIGGER synthetic_create_fail');
    assert.equal(store.create(body).id, body.id); assert.equal(store.create(body).id, body.id); assert.equal(store.count(), 1);
    const orphan = randomUUID(), file = path.join(store.root, 'uploads', orphan); fs.writeFileSync(file, 'preserve orphan');
    assert.throws(() => store.create({ ...body, id: orphan }), /ATTACHMENT_ORPHAN_CONFLICT/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'preserve orphan');
  } finally { store.close(); }
});

test('附件断点续传、重复分片与重启保留持久偏移，完成前不可读取', t => {
  const box = sandbox(t), root = path.join(box.root, 'attachments'), bytes = Buffer.from('synthetic-only-content');
  let store = new AttachmentStore(root);
  try {
    const row = store.create(metadata(bytes));
    assert.throws(() => store.verify(row.id), /ATTACHMENT_NOT_READY/);
    assert.equal(store.write(row.id, 0, bytes.subarray(0, 4)).offset, 4);
    assert.equal(store.write(row.id, 0, bytes.subarray(0, 4)).offset, 4);
    assert.throws(() => store.write(row.id, 0, Buffer.from('oops')), /ATTACHMENT_CHUNK_CONFLICT/);
    store.close(); store = new AttachmentStore(root);
    assert.equal(store.get(row.id).offset, 4);
    store.write(row.id, 4, bytes.subarray(4));
    const ready = store.complete(row.id); assert.equal(ready.state, 'ready');
    assert.deepEqual(store.complete(row.id), ready);
    assert.deepEqual(fs.readFileSync(store.verify(row.id).file), bytes);
  } finally { store.close(); }
});

test('落盘后元数据提交失败的分片可以用原偏移恢复，不暴露未确认尾部', t => {
  const box = sandbox(t), store = new AttachmentStore(path.join(box.root, 'attachments')), bytes = Buffer.from('abcdefgh');
  try {
    const row = store.create(metadata(bytes));
    store.db.exec("CREATE TRIGGER synthetic_fail BEFORE UPDATE OF offset ON attachments BEGIN SELECT RAISE(ABORT,'SYNTHETIC_DISK_FAILURE'); END");
    assert.throws(() => store.write(row.id, 0, bytes.subarray(0, 6)), /SYNTHETIC_DISK_FAILURE/);
    assert.equal(store.get(row.id).offset, 0); assert.throws(() => store.complete(row.id), /ATTACHMENT_INCOMPLETE/);
    store.db.exec('DROP TRIGGER synthetic_fail');
    store.write(row.id, 0, bytes.subarray(0, 3));
    assert.equal(fs.statSync(path.join(store.root, 'uploads', row.id)).size, 3);
    store.write(row.id, 3, bytes.subarray(3)); store.complete(row.id);
    assert.deepEqual(fs.readFileSync(store.verify(row.id).file), bytes);
  } finally { store.close(); }
});

test('附件导入保留名称与原件，按内容去重，不相信扩展名提供的媒体类型', t => {
  const box = sandbox(t), store = new AttachmentStore(path.join(box.root, 'attachments'));
  try {
    const source = path.join(box.root, 'source.png'), bytes = Buffer.from('<script>synthetic</script>'); fs.writeFileSync(source, bytes);
    const first = store.importFile(source, '../../只作显示.png'), second = store.importFile(source, '另一份.png');
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/import-attachments.mjs', import.meta.url)), path.join(box.root, 'cli-attachments'), source], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr); const imported = JSON.parse(cli.stdout);
    assert.equal(imported.sourceFilesModified, false); assert.equal(imported.attachments[0].sha256, first.sha256);
    assert.notEqual(first.id, second.id); assert.equal(first.sha256, second.sha256);
    assert.equal(first.media_type, 'application/octet-stream'); assert.equal(first.name, '../../只作显示.png');
    assert.equal(fs.readdirSync(path.join(store.root, 'objects')).length, 1);
    assert.deepEqual(fs.readFileSync(source), bytes);
    fs.writeFileSync(store.verify(first.id).file, 'tampered');
    assert.throws(() => store.verify(first.id), /ATTACHMENT_OBJECT_DAMAGED/);
  } finally { store.close(); }
});

test('附件哈希、大小、分片位置与路径边界校验失败时不能发布', t => {
  const box = sandbox(t), store = new AttachmentStore(path.join(box.root, 'attachments'));
  try {
    assert.throws(() => store.create({ name: 'large', bytes: MAX_ATTACHMENT_BYTES + 1, sha256: hash('') }), /INVALID_ATTACHMENT_METADATA/);
    const row = store.create(metadata(Buffer.from('abcd')));
    assert.throws(() => store.write(row.id, 1, Buffer.from('a')), /ATTACHMENT_OFFSET_CONFLICT/);
    assert.throws(() => store.write(row.id, 0, Buffer.alloc(MAX_CHUNK_BYTES + 1)), /INVALID_ATTACHMENT_CHUNK/);
    store.write(row.id, 0, Buffer.from('xxxx'));
    assert.throws(() => store.complete(row.id), /ATTACHMENT_HASH_MISMATCH/);
    assert.equal(store.get(row.id).state, 'uploading');
    assert.throws(() => store.get('../source'), /INVALID_ATTACHMENT_ID/);
    assert.throws(() => store.file('objects', '../source'), /ATTACHMENT_PATH_REFUSED/);
    assert.throws(() => store.file('..', hash('')), /ATTACHMENT_PATH_REFUSED/);
    const objects = path.join(store.root, 'objects'); fs.rmdirSync(objects); fs.symlinkSync(box.root, objects, 'junction');
    try { assert.throws(() => store.file('objects', hash('')), /ATTACHMENT_PATH_REFUSED/); }
    finally { fs.unlinkSync(objects); fs.mkdirSync(objects); }
  } finally { store.close(); }
});

test('空附件可完成，同目录并发打开用SQLite事务串行推进同一上传', t => {
  const box = sandbox(t), root = path.join(box.root, 'attachments'), first = new AttachmentStore(root), second = new AttachmentStore(root);
  try {
    const empty = first.create(metadata(Buffer.alloc(0))); assert.equal(first.complete(empty.id).state, 'ready');
    const content = Buffer.from('synthetic'), row = first.create(metadata(content));
    first.write(row.id, 0, content.subarray(0, 2));
    assert.equal(second.write(row.id, 0, content.subarray(0, 2)).offset, 2);
    second.write(row.id, 2, content.subarray(2)); first.complete(row.id);
    assert.deepEqual(fs.readFileSync(second.verify(row.id).file), content);
  } finally { second.close(); first.close(); }
});

test('附件快照持有写屏障，另一连接不能推进分片，快照完成后恢复续传', async t => {
  const box = sandbox(t), root = path.join(box.root, 'attachments'), source = new AttachmentStore(root), writer = new AttachmentStore(root);
  let snapshot;
  try {
    writer.db.exec('PRAGMA busy_timeout=0');
    const bytes = Buffer.from('synthetic snapshot barrier'), row = source.create(metadata(bytes)); source.write(row.id, 0, bytes.subarray(0, 4));
    const destination = path.join(box.root, 'snapshot'); snapshot = source.checkpoint(destination);
    assert.throws(() => writer.write(row.id, 4, bytes.subarray(4)), /locked/);
    await snapshot; assert.equal(verifyAttachmentSnapshot(destination).attachments, 1);
    writer.write(row.id, 4, bytes.subarray(4)); writer.complete(row.id);
    assert.equal(fs.readFileSync(path.join(destination, 'uploads', row.id), 'utf8'), bytes.subarray(0, 4).toString());
    assert.deepEqual(fs.readFileSync(source.verify(row.id).file), bytes);
  } finally { await snapshot?.catch(() => {}); writer.close(); source.close(); }
});
