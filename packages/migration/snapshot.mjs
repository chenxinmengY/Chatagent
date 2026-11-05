import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  // Array.from 会访问空槽并将其作为 undefined 拒绝，不能让稀疏数组变成另一份JSON。
  if (Array.isArray(value)) return '[' + Array.from(value, canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  throw new Error('INVALID_JSON_VALUE');
}

export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value);

export function makeSnapshot({ sourceId, scope, parentId = null, coverage, objects, status = 'complete', capturedAt = Date.now() }) {
  const snapshot = { version: 1, snapshotId: randomUUID(), sourceId, scope, parentId, coverage: [...coverage].sort(),
    status, capturedAt, objects: objects.map(({ key, value }) => ({ key, value, hash: digest(value) })) };
  validateSnapshot(snapshot);
  return snapshot;
}

export function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== 1 || !id(snapshot.snapshotId) || !id(snapshot.sourceId) || !id(snapshot.scope) ||
    !(snapshot.parentId === null || id(snapshot.parentId)) || snapshot.parentId === snapshot.snapshotId ||
    !['complete', 'partial'].includes(snapshot.status) || !Number.isSafeInteger(snapshot.capturedAt) || snapshot.capturedAt < 0 ||
    !Array.isArray(snapshot.coverage) || snapshot.coverage.length === 0 || snapshot.coverage.some(x => !id(x)) ||
    new Set(snapshot.coverage).size !== snapshot.coverage.length || !Array.isArray(snapshot.objects)) throw new Error('INVALID_SNAPSHOT');
  const keys = new Set();
  for (const object of snapshot.objects) {
    if (!object || !id(object.key) || keys.has(object.key) || object.hash !== digest(object.value)) throw new Error('INVALID_SNAPSHOT_OBJECT');
    keys.add(object.key);
  }
  canonical(snapshot);
  return snapshot;
}

function checkedSource(file) {
  const resolved = path.resolve(file);
  for (let current = resolved; ; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('SOURCE_LINK_NOT_ALLOWED');
    if (path.dirname(current) === current) break;
  }
  if (!fs.statSync(resolved).isFile()) throw new Error('SOURCE_NOT_FILE');
  return resolved;
}

// 针对显式指定的历史库进行单库备份；不构造会修改生产库的 HistoryStore。
// 调用者必须提供一个尚不存在的隔离目录。本模块没有生产路径默认值。
export async function captureHistory(sourceFile, destinationDirectory, metadata) {
  const source = checkedSource(sourceFile);
  for (const suffix of ['-wal', '-shm']) if (fs.existsSync(source + suffix)) checkedSource(source + suffix);
  makeSnapshot({ ...metadata, coverage: ['wechatagent.history.records'], objects: [] });
  const destination = path.resolve(destinationDirectory);
  const parent = path.dirname(destination);
  if (fs.realpathSync(parent).toLowerCase() !== parent.toLowerCase()) throw new Error('DESTINATION_LINK_NOT_ALLOWED');
  const sourceDirectory = path.dirname(source);
  const relative = path.relative(sourceDirectory, destination);
  if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('DESTINATION_INSIDE_SOURCE');
  }
  fs.mkdirSync(destination); // 已有目标即拒绝，绝不覆盖。
  const databaseFile = path.join(destination, 'history.sqlite');
  const input = new DatabaseSync(source, { readOnly: true });
  try { await backup(input, databaseFile); } finally { input.close(); }
  const output = new DatabaseSync(databaseFile, { readOnly: true });
  let snapshot;
  try {
    if (output.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('SQLITE_CHECK_FAILED');
    const rows = output.prepare('SELECT chat,id,at,body,text,source FROM records ORDER BY chat,id').all();
    const objects = rows.map(row => ({ key: canonical([row.chat, row.id]), value: {
      chat: row.chat, id: row.id, at: row.at, body: JSON.parse(row.body), text: row.text, source: row.source
    } }));
    snapshot = makeSnapshot({ ...metadata, coverage: ['wechatagent.history.records'], objects });
  } finally { output.close(); }
  fs.writeFileSync(path.join(destination, 'snapshot.json'), JSON.stringify(snapshot, null, 2), { flag: 'wx' });
  return snapshot;
}
