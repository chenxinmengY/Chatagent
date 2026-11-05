import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ChatStore } from '../conversation/store.mjs';

export function verifyLocalDatabase(file, expectedMessages, { requireAttachments = false } = {}) {
  const probe = new DatabaseSync(file, { readOnly: true });
  try {
    if (probe.prepare('PRAGMA application_id').get().application_id !== 0x43414348) throw Error('FOREIGN_DATABASE_REFUSED');
    if (probe.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('BACKUP_SQLITE_INVALID');
    const columns = {
      settings: { key: 'TEXT', value: 'TEXT' },
      messages: { seq: 'INTEGER', id: 'TEXT', device: 'TEXT', client_id: 'TEXT', role: 'TEXT', text: 'TEXT', mode: 'TEXT',
        queued_at: 'INTEGER', created_at: 'INTEGER', confirmed_at: 'INTEGER', state: 'TEXT', revision: 'INTEGER', parent: 'TEXT' },
      changes: { seq: 'INTEGER', body: 'TEXT' }
    };
    const required = { settings: ['value'], messages: ['id', 'role', 'text', 'mode', 'queued_at', 'created_at', 'state', 'revision'], changes: ['body'] };
    for (const [table, expected] of Object.entries(columns)) {
      if (probe.prepare("SELECT type FROM sqlite_schema WHERE name=?").get(table)?.type !== 'table') throw Error('BACKUP_SCHEMA_INVALID');
      const actual = new Map(probe.prepare('SELECT name,type,pk,"notnull" FROM pragma_table_info(?)').all(table).map(row => [row.name, row]));
      if (Object.entries(expected).some(([name, type]) => actual.get(name)?.type.toUpperCase() !== type) ||
          required[table].some(name => actual.get(name)?.notnull !== 1) ||
          [...actual.values()].filter(row => row.pk).map(row => row.name).join(',') !== (table === 'settings' ? 'key' : 'seq')) throw Error('BACKUP_SCHEMA_INVALID');
    }
    const uniqueKeys = probe.prepare('SELECT name FROM pragma_index_list(?) WHERE "unique"=1 AND partial=0').all('messages')
      .map(index => probe.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(index.name).map(row => row.name).join(','));
    if (['id', 'parent', 'device,client_id'].some(key => !uniqueKeys.includes(key))) throw Error('BACKUP_SCHEMA_INVALID');
    const mode = probe.prepare("SELECT value FROM settings WHERE key='mode'").get()?.value;
    const epoch = probe.prepare("SELECT value FROM settings WHERE key='sync_epoch'").get()?.value;
    if (!['social', 'assistant'].includes(mode) || typeof epoch !== 'string' || !epoch) throw Error('BACKUP_SCHEMA_INVALID');
    if (probe.prepare('SELECT COUNT(*) n FROM messages').get().n !== expectedMessages) throw Error('BACKUP_MESSAGE_COUNT_MISMATCH');
    const references = [];
    const attachmentColumn = probe.prepare("SELECT type,\"notnull\" FROM pragma_table_info('messages') WHERE name='attachments'").get();
    if (requireAttachments && (!attachmentColumn || attachmentColumn.type !== 'TEXT' || attachmentColumn.notnull !== 1)) throw Error('BACKUP_SCHEMA_INVALID');
    if (attachmentColumn) {
      for (const row of probe.prepare('SELECT attachments FROM messages').all()) {
        const list = JSON.parse(row.attachments);
        if (!Array.isArray(list) || list.length > 8 || new Set(list.map(item => item?.id)).size !== list.length || list.some(item => !item || !/^[a-f0-9-]{36}$/.test(item.id ?? '') || typeof item.name !== 'string' || !item.name.trim() || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '') || typeof item.mediaType !== 'string')) throw Error('BACKUP_ATTACHMENT_REFERENCE_INVALID');
        references.push(...list);
      }
    }
    return references;
  } finally { probe.close(); }
}

// 仅恢复本工具自己的消息库到全新隔离目录；不切换服务，不处理WeChatAgent/DSH资料。
export function restoreLocalBackup(backupDirectory, targetDirectory) {
  const source = path.resolve(backupDirectory), target = path.resolve(targetDirectory);
  if (fs.realpathSync(source).toLowerCase() !== source.toLowerCase() ||
      fs.realpathSync(path.dirname(target)).toLowerCase() !== path.dirname(target).toLowerCase()) throw Error('RESTORE_LINK_REFUSED');
  const manifestFile = path.join(source, 'manifest.json'), sourceFile = path.join(source, 'chat.sqlite');
  for (const file of [manifestFile, sourceFile]) if (fs.lstatSync(file).isSymbolicLink()) throw Error('RESTORE_LINK_REFUSED');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.version !== 1 || manifest.status !== 'complete' || !Number.isSafeInteger(manifest.messages) || manifest.messages < 0 ||
      JSON.stringify(manifest.coverage) !== JSON.stringify(['chatagent.local-chat.sqlite']) ||
      createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex') !== manifest.sha256) throw Error('BACKUP_VERIFICATION_FAILED');
  fs.mkdirSync(target);
  const file = path.join(target, 'chat.sqlite'); fs.copyFileSync(sourceFile, file, fs.constants.COPYFILE_EXCL);
  if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== manifest.sha256) throw Error('BACKUP_CHANGED_DURING_RESTORE');
  // 必须在 ChatStore 的建表、默认设置和恢复状态写入之前核对原始副本。
  if (verifyLocalDatabase(file, manifest.messages).length) throw Error('BACKUP_ATTACHMENTS_MISSING');
  const store = new ChatStore(file);
  try {
    store.resetEpochAfterRestore(); store.recoverRestoredWork();
    fs.writeFileSync(path.join(target, '.chatagent-local.json'), JSON.stringify({ format: 'chatagent-local-v1', id: randomUUID(), restoredFrom: manifest.id }), { flag: 'wx' });
    return { restoredFrom: manifest.id, epoch: store.epoch, messages: store.db.prepare('SELECT COUNT(*) n FROM messages').get().n };
  } finally { store.close(); }
}
