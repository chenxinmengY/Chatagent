import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { regular, fileSha, sha } from './vendor/singing/common.mjs';
const exec = promisify(execFile);

export function ownedFile(root, file) {
  const full = regular(file), relative = path.relative(path.resolve(root), full);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('CAPABILITY_OUTPUT_OUTSIDE_ROOT');
  return full;
}
export function wav(pcm, sampleRate = 24000) {
  const data = Buffer.from(pcm), header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
export async function verifyAudio(file, { expectedHash, maxSeconds = 1800, signal, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe' } = {}) {
  const before = fileSha(file);
  if (expectedHash && before !== expectedHash) throw Error('CAPABILITY_AUDIO_CHANGED');
  if (fs.statSync(file).size > 64 * 1024 * 1024) throw Error('CAPABILITY_AUDIO_TOO_LARGE');
  const opts = { windowsHide: true, timeout: 90000, maxBuffer: 65536, signal };
  const { stdout } = await exec(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type:format=duration', '-of', 'json', file], opts);
  const info = JSON.parse(stdout), seconds = Number(info.format?.duration);
  if (info.streams?.length !== 1 || info.streams[0].codec_type !== 'audio' || !['mp3', 'pcm_s16le'].includes(info.streams[0].codec_name) || !Number.isFinite(seconds) || seconds <= 0 || seconds > maxSeconds) throw Error('CAPABILITY_AUDIO_FORMAT');
  await exec(ffmpeg, ['-v', 'error', '-nostdin', '-xerror', '-i', file, '-f', 'null', '-'], opts);
  if (fileSha(file) !== before) throw Error('CAPABILITY_AUDIO_CHANGED');
  return { sha256: before, seconds, codec: info.streams[0].codec_name };
}

// Stable identity joins the capability ledger, attachment store and chat database.
// A crash after publish is resolved by reading the existing row, never regenerating.
export class MediaDelivery {
  constructor({ root, codecs = {} }) {
    this.root = root; this.codecs = codecs; this.binding = null;
    fs.mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(path.toNamespacedPath(path.join(root, 'delivery.sqlite')));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,binding TEXT NOT NULL,state TEXT NOT NULL,attachment TEXT,message TEXT)");
  }
  attach(binding) { if (this.binding) throw Error('CAPABILITY_DELIVERY_ALREADY_BOUND'); this.binding = binding; }
  async audio({ id, file, sha256, name, text, mode = 'social', signal, maxSeconds }) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw Error('CAPABILITY_DELIVERY_ID');
    if (!this.binding) throw Error('CAPABILITY_DELIVERY_NOT_CONNECTED');
    file = ownedFile(this.root, file);
    const identity = JSON.stringify({ sha256, name, text, mode });
    if (!/^[a-f0-9]{64}$/.test(sha256 ?? '')) throw Error('CAPABILITY_AUDIO_HASH_REQUIRED');
    const old = this.db.prepare('SELECT * FROM deliveries WHERE id=?').get(id);
    if (old && old.binding !== identity) throw Error('CAPABILITY_DELIVERY_CONFLICT');
    const { store, attachments } = this.binding;
    const saved = store.lookup('plugin-delivery', id);
    if (saved) {
      if (!old || saved.text !== text || saved.mode !== mode || saved.attachments.length !== 1 || saved.attachments[0].sha256 !== sha256 || saved.attachments[0].name !== name) throw Error('CAPABILITY_DELIVERY_CONFLICT');
      attachments.verify(saved.attachments[0].id);
      this.db.prepare("UPDATE deliveries SET state='saved',message=? WHERE id=?").run(saved.id, id);
      return { status: 'confirmed', evidence: 'local-database-only', messageId: saved.id };
    }
    await verifyAudio(file, { ...this.codecs, expectedHash: sha256, maxSeconds, signal }); signal?.throwIfAborted();
    const hex = sha('media\0' + id), attachmentId = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
    if (!old) this.db.prepare("INSERT INTO deliveries(id,binding,state) VALUES(?,?,'preparing')").run(id, identity);
    let row = attachments.create({ id: attachmentId, name, bytes: fs.statSync(file).size, sha256 });
    if (row.state !== 'ready') {
      const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024);
      try { let offset = row.offset, n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, offset))) { signal?.throwIfAborted(); attachments.write(row.id, offset, buffer.subarray(0, n)); offset += n; } }
      finally { fs.closeSync(fd); }
      row = attachments.complete(row.id);
    }
    row = attachments.verify(row.id); signal?.throwIfAborted();
    const ref = { id: row.id, name: row.name, bytes: row.bytes, sha256: row.sha256, mediaType: row.media_type };
    this.db.prepare("UPDATE deliveries SET state='publishing',attachment=? WHERE id=?").run(row.id, id);
    const message = store.publish({ deliveryId: id, text, mode, attachments: [ref] });
    this.db.prepare("UPDATE deliveries SET state='saved',message=? WHERE id=?").run(message.id, id);
    return { status: 'confirmed', evidence: 'local-database-only', messageId: message.id };
  }
  reconcile(id) {
    const row = this.db.prepare('SELECT * FROM deliveries WHERE id=?').get(id), message = this.binding?.store.lookup('plugin-delivery', id);
    if (!row || !message) return { status: 'unknown' };
    const expected = JSON.parse(row.binding), ref = message.attachments[0];
    if (message.text !== expected.text || message.mode !== expected.mode || message.attachments.length !== 1 || ref?.sha256 !== expected.sha256 || ref.name !== expected.name) throw Error('CAPABILITY_DELIVERY_CONFLICT');
    this.binding.attachments.verify(ref.id);
    return { status: 'confirmed', evidence: 'local-database-only', messageId: message.id };
  }
  text(id, text, mode = 'social') { if (!this.binding) throw Error('CAPABILITY_DELIVERY_NOT_CONNECTED'); return this.binding.store.publish({ deliveryId: id, text, mode }); }
  close() { this.db.close(); }
}
