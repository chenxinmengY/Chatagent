import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { probeAudioDuration } from './audio-duration.mjs';

const APPLICATION_ID = 0x43414649;
const FORMAT = 'chatagent-attachments-v1';
const fail = code => { throw Error(code); };
const idPattern = /^[a-f0-9-]{36}$/;
const hashPattern = /^[a-f0-9]{64}$/;
export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 1024 * 1024;

function plain(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || fs.realpathSync(file).toLowerCase() !== path.resolve(file).toLowerCase()) fail('ATTACHMENT_PATH_REFUSED');
  return stat;
}

function digestFile(file) {
  plain(file);
  const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(256 * 1024), hash = createHash('sha256');
  try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function mediaType(file) {
  const fd = fs.openSync(file, 'r'), bytes = Buffer.alloc(16);
  let n;
  try { n = fs.readSync(fd, bytes, 0, bytes.length, 0); } finally { fs.closeSync(fd); }
  if (n >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (n >= 3 && bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  if (n >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (n >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp' && ['M4A ', 'M4B '].includes(bytes.toString('ascii', 8, 12))) return 'audio/mp4';
  if (n >= 4 && bytes.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (n >= 4 && bytes.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac';
  if (n >= 3 && (bytes.toString('ascii', 0, 3) === 'ID3' || bytes[0] === 0xff && (bytes[1] & 0xe6) === 0xe2)) return 'audio/mpeg';
  if (n >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF') {
    if (bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    if (bytes.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  }
  return 'application/octet-stream';
}

// 独立附件仓库。文件名仅是显示信息；所有磁盘位置由本模块生成。
export class AttachmentStore {
  constructor(root) {
    if (!path.isAbsolute(root)) fail('ABSOLUTE_ATTACHMENT_ROOT_REQUIRED');
    root = path.resolve(root);
    let ancestor = root; while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    plain(ancestor, true); fs.mkdirSync(root, { recursive: true }); plain(root, true);
    const marker = path.join(root, '.chatagent-attachments.json');
    if (!fs.existsSync(marker)) {
      if (fs.readdirSync(root).length) fail('FOREIGN_ATTACHMENT_ROOT_REFUSED');
      fs.writeFileSync(marker, JSON.stringify({ format: FORMAT, id: randomUUID() }), { flag: 'wx' });
    }
    plain(marker);
    if (JSON.parse(fs.readFileSync(marker, 'utf8')).format !== FORMAT) fail('FOREIGN_ATTACHMENT_ROOT_REFUSED');
    this.root = root;
    for (const name of ['uploads', 'objects']) { const directory = path.join(root, name); if (!fs.existsSync(directory)) fs.mkdirSync(directory); plain(directory, true); }
    const database = path.join(root, 'attachments.sqlite');
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(database + suffix)) plain(database + suffix);
    if (fs.existsSync(database)) {
      const check = new DatabaseSync(database, { readOnly: true });
      try { if (check.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID) fail('FOREIGN_ATTACHMENT_DATABASE_REFUSED'); }
      finally { check.close(); }
    }
    this.db = new DatabaseSync(database);
    this.db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,name TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,
        offset INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'uploading',media_type TEXT NOT NULL DEFAULT 'application/octet-stream');
      CREATE TABLE IF NOT EXISTS audio_metadata(sha256 TEXT PRIMARY KEY,duration_ms INTEGER);`);
  }

  close() { this.db.close(); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  file(directory, name) {
    if (!['uploads', 'objects'].includes(directory) || !(directory === 'uploads' ? idPattern : hashPattern).test(name ?? '')) fail('ATTACHMENT_PATH_REFUSED');
    plain(this.root, true); plain(path.join(this.root, directory), true); return path.join(this.root, directory, name);
  }
  get(id) {
    if (!idPattern.test(id ?? '')) fail('INVALID_ATTACHMENT_ID');
    const row = this.db.prepare('SELECT * FROM attachments WHERE id=?').get(id);
    if (!row) fail('ATTACHMENT_NOT_FOUND');
    return row;
  }
  create({ name, bytes, sha256, id = randomUUID() }) {
    if (typeof name !== 'string' || !name.isWellFormed() || !name.trim() || name.length > 255 || /[\x00-\x1f]/.test(name) ||
        !Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_ATTACHMENT_BYTES || !hashPattern.test(sha256 ?? '') || !idPattern.test(id ?? '')) fail('INVALID_ATTACHMENT_METADATA');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM attachments WHERE id=?').get(id);
      if (existing) {
        if (existing.name !== name || existing.bytes !== bytes || existing.sha256 !== sha256) fail('ATTACHMENT_ID_REUSED');
        return existing;
      }
      const file = this.file('uploads', id);
      // 空文件创建后、元数据提交前崩溃，重试可认领同ID空文件；非空孤儿不能擅自覆盖。
      if (fs.existsSync(file)) { if (plain(file).size !== 0) fail('ATTACHMENT_ORPHAN_CONFLICT'); }
      else { const fd = fs.openSync(file, 'wx'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
      this.db.prepare('INSERT INTO attachments(id,name,bytes,sha256) VALUES(?,?,?,?)').run(id, name, bytes, sha256);
      return this.get(id);
    });
  }
  write(id, offset, chunk) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Buffer.isBuffer(chunk) || !chunk.length || chunk.length > MAX_CHUNK_BYTES) fail('INVALID_ATTACHMENT_CHUNK');
    return this.transaction(() => {
      const row = this.get(id);
      if (row.state !== 'uploading') fail('ATTACHMENT_ALREADY_READY');
      if (offset > row.offset || offset + chunk.length > row.bytes || offset < row.offset && offset + chunk.length > row.offset) fail('ATTACHMENT_OFFSET_CONFLICT');
      const file = this.file('uploads', id), stat = plain(file);
      if (stat.size < row.offset) fail('ATTACHMENT_UPLOAD_DAMAGED');
      const fd = fs.openSync(file, 'r+');
      try {
        if (offset < row.offset) {
          const previous = Buffer.alloc(chunk.length); fs.readSync(fd, previous, 0, previous.length, offset);
          if (!previous.equals(chunk)) fail('ATTACHMENT_CHUNK_CONFLICT');
          return row; // 响应丢失的相同分片重传，只返回已持久化偏移。
        }
        let written = 0;
        while (written < chunk.length) { const n = fs.writeSync(fd, chunk, written, chunk.length - written, offset + written); if (!n) fail('ATTACHMENT_WRITE_FAILED'); written += n; }
        // 崩溃可能留下未确认的尾部；只保留本次已写入且随后持久化的分片。
        fs.ftruncateSync(fd, offset + chunk.length); fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      this.db.prepare('UPDATE attachments SET offset=? WHERE id=?').run(offset + chunk.length, id);
      return this.get(id);
    });
  }
  complete(id) {
    return this.transaction(() => {
      const row = this.get(id);
      if (row.state === 'ready') { this.verify(id); return row; }
      if (row.offset !== row.bytes) fail('ATTACHMENT_INCOMPLETE');
      const source = this.file('uploads', id);
      if (plain(source).size !== row.bytes || digestFile(source) !== row.sha256) fail('ATTACHMENT_HASH_MISMATCH');
      const destination = this.file('objects', row.sha256);
      if (!fs.existsSync(destination)) {
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
        const fd = fs.openSync(destination, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      if (plain(destination).size !== row.bytes || digestFile(destination) !== row.sha256) fail('ATTACHMENT_OBJECT_DAMAGED');
      this.db.prepare("UPDATE attachments SET state='ready',media_type=? WHERE id=?").run(mediaType(destination), id);
      return this.get(id);
    });
  }
  verify(id) {
    const row = this.get(id);
    if (row.state !== 'ready' || !hashPattern.test(row.sha256)) fail('ATTACHMENT_NOT_READY');
    const file = this.file('objects', row.sha256);
    if (plain(file).size !== row.bytes || digestFile(file) !== row.sha256) fail('ATTACHMENT_OBJECT_DAMAGED');
    return { ...row, file };
  }
  count() { return this.db.prepare('SELECT COUNT(*) n FROM attachments').get().n; }
  audioDuration(id) {
    const row = this.get(id);
    if (row.state !== 'ready' || !row.media_type.startsWith('audio/')) return null;
    const cached = this.db.prepare('SELECT duration_ms FROM audio_metadata WHERE sha256=?').get(row.sha256);
    if (cached) return cached.duration_ms;
    const checked = this.verify(id), duration = probeAudioDuration(checked.file);
    this.db.prepare('INSERT OR IGNORE INTO audio_metadata VALUES(?,?)').run(row.sha256, duration);
    return duration;
  }
  async checkpoint(destination) {
    plain(path.dirname(destination), true);
    const relative = path.relative(this.root, destination);
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) fail('ATTACHMENT_SNAPSHOT_INSIDE_SOURCE');
    // 持有写锁阻止同仓库的另一个CLI在捕获期间推进分片；在线备份从独立只读连接取快照。
    this.db.exec('BEGIN IMMEDIATE');
    let input;
    try {
      fs.mkdirSync(destination); fs.mkdirSync(path.join(destination, 'uploads')); fs.mkdirSync(path.join(destination, 'objects'));
      plain(path.join(this.root, '.chatagent-attachments.json'));
      fs.copyFileSync(path.join(this.root, '.chatagent-attachments.json'), path.join(destination, '.chatagent-attachments.json'), fs.constants.COPYFILE_EXCL);
      input = new DatabaseSync(path.join(this.root, 'attachments.sqlite'), { readOnly: true });
      await backup(input, path.join(destination, 'attachments.sqlite')); input.close(); input = null;
      const sealed = new DatabaseSync(path.join(destination, 'attachments.sqlite'));
      try { sealed.exec('PRAGMA journal_mode=DELETE'); } finally { sealed.close(); }
      for (const row of this.db.prepare('SELECT * FROM attachments').all()) {
        if (row.state === 'ready') {
          const verified = this.verify(row.id), target = path.join(destination, 'objects', row.sha256);
          if (!fs.existsSync(target)) fs.copyFileSync(verified.file, target, fs.constants.COPYFILE_EXCL);
          if (digestFile(target) !== row.sha256) fail('ATTACHMENT_OBJECT_DAMAGED');
        } else {
          const file = this.file('uploads', row.id);
          if (plain(file).size < row.offset) fail('ATTACHMENT_UPLOAD_DAMAGED');
          const source = fs.openSync(file, 'r'), target = fs.openSync(path.join(destination, 'uploads', row.id), 'wx');
          try {
            const buffer = Buffer.alloc(MAX_CHUNK_BYTES); let offset = 0;
            while (offset < row.offset) {
              const n = fs.readSync(source, buffer, 0, Math.min(buffer.length, row.offset - offset), offset);
              if (!n) fail('ATTACHMENT_UPLOAD_DAMAGED');
              let written = 0; while (written < n) { const m = fs.writeSync(target, buffer, written, n - written, offset + written); if (!m) fail('ATTACHMENT_WRITE_FAILED'); written += m; }
              offset += n;
            }
            fs.fsyncSync(target);
          } finally { fs.closeSync(source); fs.closeSync(target); }
        }
      }
    } finally { input?.close(); this.db.exec('ROLLBACK'); }
  }
  importFile(source, name = path.basename(source)) {
    plain(source);
    const bytes = fs.statSync(source).size;
    if (bytes > MAX_ATTACHMENT_BYTES) fail('INVALID_ATTACHMENT_METADATA');
    const sha256 = digestFile(source);
    const row = this.create({ name, bytes, sha256 });
    const fd = fs.openSync(source, 'r'), chunk = Buffer.alloc(MAX_CHUNK_BYTES);
    try { let n, offset = 0; while ((n = fs.readSync(fd, chunk, 0, chunk.length, null))) { this.write(row.id, offset, chunk.subarray(0, n)); offset += n; } }
    finally { fs.closeSync(fd); }
    return this.complete(row.id); // 来源在拷贝时变化会使hash或大小校验失败，不能发布ready。
  }
}

// 不构造可写仓库；恢复发布前核对元数据、对象和所有消息引用。
export function verifyAttachmentSnapshot(root, references = []) {
  plain(root, true);
  const markerFile = path.join(root, '.chatagent-attachments.json'); plain(markerFile);
  if (JSON.parse(fs.readFileSync(markerFile, 'utf8')).format !== FORMAT) fail('FOREIGN_ATTACHMENT_ROOT_REFUSED');
  const file = path.join(root, 'attachments.sqlite'); plain(file);
  const header = Buffer.alloc(20), fd = fs.openSync(file, 'r'); try { fs.readSync(fd, header, 0, 20, 0); } finally { fs.closeSync(fd); }
  if (header[18] !== 1 || header[19] !== 1) fail('ATTACHMENT_SNAPSHOT_NOT_SEALED');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('ATTACHMENT_SNAPSHOT_INVALID');
    if (db.prepare("SELECT type FROM sqlite_schema WHERE name='attachments'").get()?.type !== 'table') fail('ATTACHMENT_SNAPSHOT_INVALID');
    const columns = db.prepare("SELECT name,type,pk,\"notnull\" FROM pragma_table_info('attachments')").all();
    const expected = { id: 'TEXT', name: 'TEXT', bytes: 'INTEGER', sha256: 'TEXT', offset: 'INTEGER', state: 'TEXT', media_type: 'TEXT' };
    if (columns.filter(row => row.pk).map(row => row.name).join(',') !== 'id' ||
        Object.entries(expected).some(([name, type]) => !columns.some(row => row.name === name && row.type === type && (name === 'id' || row.notnull === 1)))) fail('ATTACHMENT_SNAPSHOT_INVALID');
    const rows = db.prepare('SELECT * FROM attachments').all(), byId = new Map();
    for (const row of rows) {
      if (!idPattern.test(row.id ?? '') || byId.has(row.id) || !hashPattern.test(row.sha256 ?? '') || typeof row.name !== 'string' || !row.name.trim() ||
          !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > MAX_ATTACHMENT_BYTES || !Number.isSafeInteger(row.offset) || row.offset < 0 || row.offset > row.bytes || !['uploading', 'ready'].includes(row.state)) fail('ATTACHMENT_SNAPSHOT_INVALID');
      byId.set(row.id, row);
      const directory = path.join(root, row.state === 'ready' ? 'objects' : 'uploads'); plain(directory, true);
      const content = path.join(directory, row.state === 'ready' ? row.sha256 : row.id);
      if (plain(content).size !== row.offset || row.state === 'ready' && (row.offset !== row.bytes || digestFile(content) !== row.sha256)) fail('ATTACHMENT_SNAPSHOT_INVALID');
    }
    for (const reference of references) {
      const row = byId.get(reference.id);
      if (!row || row.state !== 'ready' || row.name !== reference.name || row.bytes !== reference.bytes || row.sha256 !== reference.sha256 || row.media_type !== reference.mediaType) fail('ATTACHMENT_REFERENCE_INVALID');
    }
    return { attachments: rows.length, ready: rows.filter(row => row.state === 'ready').length };
  } finally { db.close(); }
}
