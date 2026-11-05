import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import { ChatStore } from '../conversation/store.mjs';
import { verifyLocalDatabase } from './local-restore.mjs';
import { verifyAttachmentSnapshot } from '../storage/attachments.mjs';
import { verifyNativeBackup } from './native-backup.mjs';

const FORMAT = 'chatagent-runtime-backup-v1';
const COVERAGE = ['chatagent.local-chat.sqlite', 'chatagent.isolated-dsh'];
const hash = file => {
  const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(256 * 1024), digest = createHash('sha256');
  try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return digest.digest('hex');
};
const fail = code => { throw Error(code); };

function sameInventory(actual, expected) {
  if (!Array.isArray(expected) || actual.length !== expected.length) return false;
  const rows = new Map();
  for (const row of expected) {
    if (!row || typeof row.path !== 'string' || rows.has(row.path) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 ||
        !/^[a-f0-9]{64}$/.test(row.sha256 ?? '') || Object.keys(row).sort().join(',') !== 'bytes,path,sha256') return false;
    rows.set(row.path, row);
  }
  return actual.every(row => rows.get(row.path)?.bytes === row.bytes && rows.get(row.path)?.sha256 === row.sha256);
}

export function sealDatabase(file) {
  const db = new DatabaseSync(path.toNamespacedPath(file));
  try { db.exec('PRAGMA journal_mode=DELETE'); } finally { db.close(); }
}

function assertSealed(file) {
  const fd = fs.openSync(file, 'r'), header = Buffer.alloc(20);
  try { fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
  if (header[18] !== 1 || header[19] !== 1) fail('BACKUP_DATABASE_NOT_SEALED');
}

export function plainDirectory(directory) {
  if (fs.realpathSync(directory).toLowerCase() !== path.resolve(directory).toLowerCase() || !fs.lstatSync(directory).isDirectory()) fail('BACKUP_LINK_REFUSED');
}

// 文件清单同时用于完整性验证和拷贝；不跟随链接，不允许清单定位任意磁盘路径。
export function inventory(directory, prefix = '') {
  plainDirectory(directory);
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (/[\x00-\x1f<>:"/\\|?*]/.test(entry.name) || entry.name === '.' || entry.name === '..') fail('BACKUP_FILE_NAME_REFUSED');
    const file = path.join(directory, entry.name), relative = prefix + entry.name;
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) fail('BACKUP_LINK_REFUSED');
    if (stat.isDirectory()) files.push(...inventory(file, relative + '/'));
    else if (stat.isFile()) files.push({ path: relative, bytes: stat.size, sha256: hash(file) });
    else fail('BACKUP_FILE_TYPE_REFUSED');
  }
  return files;
}

export function copyTree(source, target) {
  const files = inventory(source);
  fs.mkdirSync(target);
  for (const item of files) {
    const destination = path.join(target, ...item.path.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(source, ...item.path.split('/')), destination, fs.constants.COPYFILE_EXCL);
    if (hash(destination) !== item.sha256) fail('BACKUP_SOURCE_CHANGED');
  }
  // 原生会话允许空工作目录；恢复运行时也会按需建立。
}

function checkLedger(file, identity, sessionsRoot) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare('PRAGMA application_id').get().application_id !== 0x43414453 || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('BACKUP_DSH_LEDGER_INVALID');
    for (const [table, columns] of Object.entries({ modes: ['mode', 'session_id'], requests: ['id', 'mode', 'text_hash', 'state', 'reply', 'session_id'] })) {
      if (db.prepare('SELECT type FROM sqlite_schema WHERE name=?').get(table)?.type !== 'table') fail('BACKUP_DSH_LEDGER_INVALID');
      const actual = db.prepare('SELECT name,type,pk,"notnull" FROM pragma_table_info(?)').all(table);
      if (columns.some(name => !actual.some(row => row.name === name && row.type === 'TEXT')) ||
          actual.filter(row => row.pk).map(row => row.name).join(',') !== (table === 'modes' ? 'mode' : 'id') ||
          columns.filter(name => !['mode', 'id', 'reply'].includes(name) || table === 'requests' && name === 'mode').some(name => !actual.find(row => row.name === name)?.notnull)) fail('BACKUP_DSH_LEDGER_INVALID');
    }
    if (db.prepare("SELECT 1 FROM modes WHERE mode NOT IN ('social','assistant') LIMIT 1").get() ||
        db.prepare("SELECT 1 FROM requests WHERE id IS NULL OR mode NOT IN ('social','assistant') OR state NOT IN ('completed','unknown','running') OR length(text_hash)!=64 OR (state='completed' AND (reply IS NULL OR length(trim(reply))=0)) LIMIT 1").get() ||
        db.prepare('SELECT 1 FROM requests r LEFT JOIN modes m ON r.mode=m.mode AND r.session_id=m.session_id WHERE m.mode IS NULL LIMIT 1').get()) fail('BACKUP_DSH_LEDGER_INVALID');
    for (const binding of db.prepare('SELECT * FROM modes').all()) {
      const expected = 'chatagent-' + binding.mode + '-' + createHash('sha256').update(identity).digest('hex').slice(0, 32);
      if (binding.session_id !== expected) fail('BACKUP_DSH_IDENTITY_MISMATCH');
    }
    verifyNativeBackup(sessionsRoot, identity, db.prepare('SELECT * FROM modes').all(), db.prepare('SELECT * FROM requests').all(), fs.existsSync(sessionsRoot) ? inventory(sessionsRoot) : []);
  } finally { db.close(); }
}

function checkPayload(payload, messages, coverage = COVERAGE) {
  assertSealed(path.join(payload, 'chat', 'chat.sqlite'));
  const references = verifyLocalDatabase(path.join(payload, 'chat', 'chat.sqlite'), messages, { requireAttachments: coverage.includes('chatagent.attachments') });
  if (coverage.includes('chatagent.attachments')) verifyAttachmentSnapshot(path.join(payload, 'chat', 'attachments'), references);
  else if (references.length) fail('BACKUP_ATTACHMENTS_MISSING');
  if (coverage.includes('chatagent.isolated-dsh')) {
    assertSealed(path.join(payload, 'dsh', 'requests.sqlite'));
    const marker = JSON.parse(fs.readFileSync(path.join(payload, 'dsh', '.chatagent-dsh.json'), 'utf8'));
    if (marker.format !== 'chatagent-isolated-dsh-v1' || !/^[a-f0-9-]{36}$/.test(marker.id ?? '')) fail('BACKUP_DSH_IDENTITY_INVALID');
    checkLedger(path.join(payload, 'dsh', 'requests.sqlite'), marker.id, path.join(payload, 'dsh', 'sessions'));
  }
}

// 调用者须先停止接纳写入并等待已接纳轮次结束；runtime在自己的队列内持有静止屏障。
export async function captureRuntimeBackup({ store, runtime = null, attachments = null, destination, now = Date.now }) {
  plainDirectory(path.dirname(destination));
  if (fs.existsSync(destination)) fail('BACKUP_TARGET_EXISTS');
  if (runtime && (runtime.kind !== 'isolated-sdk' || typeof runtime.checkpoint !== 'function') || !runtime && !attachments) fail('BACKEND_CHECKPOINT_UNSUPPORTED');
  const coverage = ['chatagent.local-chat.sqlite', ...(runtime ? ['chatagent.isolated-dsh'] : []), ...(attachments ? ['chatagent.attachments'] : [])];
  const id = path.basename(destination);
  const stage = path.join(path.dirname(destination), '.staging-' + randomUUID());
  fs.mkdirSync(stage);
  const payload = path.join(stage, 'payload'); fs.mkdirSync(payload);
  const chat = path.join(payload, 'chat'); fs.mkdirSync(chat);
  const captureChat = async () => {
    await backup(store.db, path.join(chat, 'chat.sqlite'));
    if (attachments) await attachments.checkpoint(path.join(chat, 'attachments'));
  };
  if (runtime) await runtime.checkpoint(path.join(payload, 'dsh'), captureChat); else await captureChat();
  sealDatabase(path.join(chat, 'chat.sqlite'));
  const db = new DatabaseSync(path.join(chat, 'chat.sqlite'), { readOnly: true });
  let messages;
  try { messages = db.prepare('SELECT COUNT(*) n FROM messages').get().n; } finally { db.close(); }
  checkPayload(payload, messages, coverage);
  const manifest = { version: attachments ? 2 : 1, format: attachments ? 'chatagent-archive-backup-v2' : FORMAT, id, createdAt: now(), status: 'complete', coverage,
    messages, files: inventory(payload), productionMigration: false };
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  verifyRuntimeBackup(stage);
  // Windows扫描器可能短暂占用刚写入的插件文件；保持同一完整stage，有限重试发布。
  for (let attempt = 0; ; attempt++) {
    if (fs.existsSync(destination)) fail('BACKUP_TARGET_EXISTS');
    try { fs.renameSync(stage, destination); break; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  return manifest;
}

export function verifyRuntimeBackup(directory) {
  plainDirectory(directory);
  const files = inventory(directory);
  if (files.some(item => item.path !== 'manifest.json' && !item.path.startsWith('payload/'))) fail('BACKUP_UNEXPECTED_FILE');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const legacy = manifest.format === FORMAT && manifest.version === 1 && JSON.stringify(manifest.coverage) === JSON.stringify(COVERAGE);
  const withFiles = manifest.format === 'chatagent-archive-backup-v2' && manifest.version === 2 &&
    [['chatagent.local-chat.sqlite', 'chatagent.attachments'], [...COVERAGE, 'chatagent.attachments']].some(coverage => JSON.stringify(coverage) === JSON.stringify(manifest.coverage));
  if ((!legacy && !withFiles) || manifest.status !== 'complete' ||
      typeof manifest.id !== 'string' || !manifest.id || !Number.isSafeInteger(manifest.messages) || manifest.messages < 0 ||
      !Array.isArray(manifest.files)) fail('BACKUP_MANIFEST_INVALID');
  const actual = inventory(path.join(directory, 'payload'));
  if (!sameInventory(actual, manifest.files)) fail('BACKUP_VERIFICATION_FAILED');
  // 根级清单不允许夹带运行锁/WAL/其他数据，避免恢复时启动或覆盖未知资料。
  for (const item of actual) {
    if (withFiles && item.path.startsWith('chat/attachments/')) {
      if (!/^chat\/attachments\/(?:\.chatagent-attachments\.json|attachments\.sqlite|objects\/[a-f0-9]{64}|uploads\/[a-f0-9-]{36})$/.test(item.path)) fail('BACKUP_UNEXPECTED_FILE');
      continue;
    }
    if (!manifest.coverage.includes('chatagent.isolated-dsh') && item.path.startsWith('dsh/')) fail('BACKUP_UNEXPECTED_FILE');
    if (item.path !== 'chat/chat.sqlite' && item.path !== 'dsh/.chatagent-dsh.json' && item.path !== 'dsh/requests.sqlite' &&
        !item.path.startsWith('dsh/sessions/') && !item.path.startsWith('dsh/workspaces/')) fail('BACKUP_UNEXPECTED_FILE');
  }
  checkPayload(path.join(directory, 'payload'), manifest.messages, manifest.coverage);
  return manifest;
}

// 仅发布到新目录；保留DSH身份以便核对原请求，更换聊天同步代号并冻结未结束任务。
export function restoreRuntimeBackup(directory, target) {
  directory = path.resolve(directory); target = path.resolve(target);
  const manifest = verifyRuntimeBackup(directory);
  plainDirectory(path.dirname(target));
  if (fs.existsSync(target)) fail('RESTORE_TARGET_EXISTS');
  const stage = path.join(path.dirname(target), '.restore-' + randomUUID());
  copyTree(path.join(directory, 'payload'), stage);
  if (!sameInventory(inventory(stage), manifest.files)) fail('BACKUP_CHANGED_DURING_RESTORE');
  checkPayload(stage, manifest.messages, manifest.coverage);
  const store = new ChatStore(path.join(stage, 'chat', 'chat.sqlite'));
  let epoch;
  try { store.resetEpochAfterRestore(); store.recoverRestoredWork(); epoch = store.epoch; } finally { store.close(); }
  fs.writeFileSync(path.join(stage, 'chat', '.chatagent-local.json'), JSON.stringify({ format: 'chatagent-local-v1', id: randomUUID(), restoredFrom: manifest.id }), { flag: 'wx' });
  fs.writeFileSync(path.join(stage, 'restore.json'), JSON.stringify({ format: 'chatagent-runtime-restore-v1', restoredFrom: manifest.id, epoch, executionEnabled: false }), { flag: 'wx' });
  // Windows can temporarily deny directory publication after closed SQLite
  // handles. Retry only the rename, never recopy data or replace a destination.
  for (let attempt = 0; ; attempt++) {
    if (fs.existsSync(target)) fail('RESTORE_TARGET_EXISTS');
    try { fs.renameSync(stage, target); break; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (attempt + 1));
    }
  }
  return { restoredFrom: manifest.id, epoch, messages: manifest.messages, chatRoot: path.join(target, 'chat'), dshRoot: manifest.coverage.includes('chatagent.isolated-dsh') ? path.join(target, 'dsh') : null, executionEnabled: false };
}
