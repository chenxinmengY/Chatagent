import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { assertPlain, digest } from './standby-capture.mjs';
import { inventory, copyTree, sealDatabase } from './runtime-backup.mjs';

export function verifyCapabilityArchive(root, capsule) {
  assertPlain(root);
  assertPlain(path.join(root, 'manifest.private.json'));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.private.json')));
  if (manifest.format !== 'chatagent-capability-archive-v1' || manifest.account !== capsule.account || manifest.key !== capsule.key || manifest.personaDigest !== capsule.personaDigest || manifest.completed !== true) throw Error('CAPABILITY_ARCHIVE_SCOPE');
  if (JSON.stringify(inventory(path.join(root, 'archive'))) !== JSON.stringify(manifest.files)) throw Error('CAPABILITY_ARCHIVE_CHANGED');
  return manifest;
}

// A supplemental archive for capabilities stored outside the original four API
// plugins. Every file remains evidence only; old jobs are never executable.
export async function captureCapabilityArchive({ sourceRoot, capsule, destination }) {
  if (![sourceRoot, destination].every(p => path.isAbsolute(p))) throw Error('ABSOLUTE_PATH_REQUIRED');
  sourceRoot = path.resolve(sourceRoot); destination = path.resolve(destination);
  assertPlain(sourceRoot); assertPlain(destination);
  for (const [a, b] of [[sourceRoot, destination], [destination, sourceRoot]]) { const rel = path.relative(a, b); if (!rel || !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)) throw Error('CAPABILITY_ARCHIVE_OVERLAP'); }
  if (fs.existsSync(destination)) throw Error('CAPABILITY_ARCHIVE_EXISTS');
  if (!/^[a-f0-9]{64}$/.test(capsule.account) || !/^wechat:private:[1-9]\d*$/.test(capsule.key)) throw Error('CAPABILITY_ARCHIVE_SCOPE');
  const active = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'state/weflow/active-account.json')));
  const mappingFile = path.join(sourceRoot, 'state/accounts', capsule.account, 'dsh-sessions.json');
  const check = () => { const map = JSON.parse(fs.readFileSync(mappingFile)); if (active.id !== capsule.account || JSON.parse(fs.readFileSync(path.join(sourceRoot, 'state/weflow/active-account.json'))).id !== capsule.account || digest(map.profiles?.[capsule.key]?.persona ?? '') !== capsule.personaDigest) throw Error('CAPABILITY_SOURCE_IDENTITY_CHANGED'); };
  check(); fs.mkdirSync(path.join(destination, 'archive'), { recursive: true });
  const evidence = [], absent = [];
  const folders = ['bili-archive', 'bili-reading', 'bili-visual', 'media-experiences', 'dsh-plugin-storage'].map(name => 'state/accounts/' + capsule.account + '/' + name).concat(['state/singing']);
  async function copy(file, target) {
    assertPlain(file); const stat = fs.lstatSync(file);
    if (stat.isDirectory()) { fs.mkdirSync(target, { recursive: true }); for (const name of fs.readdirSync(file).sort()) if (!/-(wal|shm|journal)$/.test(name)) await copy(path.join(file, name), path.join(target, name)); return; }
    if (!stat.isFile()) throw Error('CAPABILITY_SOURCE_TYPE');
    const bytes = fs.readFileSync(file);
    if (bytes.subarray(0, 16).toString() === 'SQLite format 3\0') {
      const db = new DatabaseSync(path.toNamespacedPath(file), { readOnly: true });
      try { await backup(db, path.toNamespacedPath(target)); } finally { db.close(); } sealDatabase(target);
    } else {
      if (!bytes.equals(fs.readFileSync(file))) throw Error('CAPABILITY_SOURCE_CHANGING');
      fs.writeFileSync(target, bytes, { flag: 'wx' }); evidence.push({ file, hash: digest(bytes) });
    }
  }
  for (const rel of folders) { const file = path.join(sourceRoot, rel); if (!fs.existsSync(file)) { absent.push(rel); continue; } fs.mkdirSync(path.dirname(path.join(destination, 'archive', rel)), { recursive: true }); await copy(file, path.join(destination, 'archive', rel)); }
  for (const item of evidence) { assertPlain(item.file); if (digest(fs.readFileSync(item.file)) !== item.hash) throw Error('CAPABILITY_SOURCE_CHANGING'); }
  check();
  const manifest = { format: 'chatagent-capability-archive-v1', id: randomUUID(), completed: true, at: new Date().toISOString(), account: capsule.account, key: capsule.key, personaDigest: capsule.personaDigest, consistency: 'stable-files-and-per-database-not-global-transaction', absent, files: inventory(path.join(destination, 'archive')) };
  fs.writeFileSync(path.join(destination, 'manifest.private.json'), JSON.stringify(manifest), { flag: 'wx' }); return verifyCapabilityArchive(destination, capsule);
}
export function importCapabilityArchive(source, destination, capsule) {
  const manifest = verifyCapabilityArchive(source, capsule);
  if (fs.existsSync(destination)) { if (verifyCapabilityArchive(destination, capsule).id !== manifest.id) throw Error('CAPABILITY_IMPORT_CONFLICT'); return; }
  assertPlain(destination); copyTree(source, destination); verifyCapabilityArchive(destination, capsule);
}
