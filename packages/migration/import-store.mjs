import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { canonical, digest, validateSnapshot } from './snapshot.mjs';

const APPLICATION_ID = 0x43414754;

// 隔离导入验证库：仅保存来源镜像、目标资料与冲突，不含任务执行或外发接口。
export class ImportStore {
  constructor(file) {
    if (!path.isAbsolute(file) || fs.realpathSync(path.dirname(file)).toLowerCase() !== path.dirname(file).toLowerCase()) {
      throw new Error('ISOLATED_TARGET_PATH_REQUIRED');
    }
    if (fs.existsSync(file)) {
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(file + suffix) && fs.lstatSync(file + suffix).isSymbolicLink()) throw new Error('TARGET_LINK_NOT_ALLOWED');
      }
      const probe = new DatabaseSync(file, { readOnly: true });
      try {
        if (probe.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID) throw new Error('FOREIGN_DATABASE_REFUSED');
      } finally { probe.close(); }
    } else {
      fs.closeSync(fs.openSync(file, 'wx'));
    }
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,hash TEXT NOT NULL,body TEXT NOT NULL,applied INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS heads(source TEXT,scope TEXT,head TEXT NOT NULL,coverage TEXT NOT NULL,PRIMARY KEY(source,scope));
      CREATE TABLE IF NOT EXISTS objects(source TEXT,scope TEXT,key TEXT,source_json TEXT,target_json TEXT,PRIMARY KEY(source,scope,key));
      CREATE TABLE IF NOT EXISTS conflicts(snapshot TEXT,key TEXT,before_json TEXT,target_json TEXT,incoming_json TEXT,PRIMARY KEY(snapshot,key));`);
  }

  close() { this.db.close(); }

  import(snapshot) {
    validateSnapshot(snapshot);
    const encoded = canonical(snapshot), hash = digest(snapshot);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#apply(snapshot, encoded, hash);
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  #apply(snapshot, encoded, hash) {
    const known = this.db.prepare('SELECT hash,applied FROM snapshots WHERE id=?').get(snapshot.snapshotId);
    if (known && known.hash !== hash) throw new Error('SNAPSHOT_ID_COLLISION');
    if (known?.applied) return { status: 'already_imported', changed: 0, conflicts: 0 };
    this.db.prepare('INSERT OR IGNORE INTO snapshots VALUES(?,?,?,0)').run(snapshot.snapshotId, hash, encoded);
    const head = this.db.prepare('SELECT head,coverage FROM heads WHERE source=? AND scope=?').get(snapshot.sourceId, snapshot.scope);
    const coverage = canonical([...snapshot.coverage].sort());
    if ((head && (head.head !== snapshot.parentId || head.coverage !== coverage)) || (!head && snapshot.parentId !== null)) {
      return { status: 'history_only', changed: 0, conflicts: 0 };
    }
    const existing = this.db.prepare('SELECT key,source_json,target_json FROM objects WHERE source=? AND scope=?')
      .all(snapshot.sourceId, snapshot.scope);
    const previous = new Map(existing.map(row => [row.key, row]));
    const incoming = new Map(snapshot.objects.map(object => [object.key, canonical(object.value)]));
    if (snapshot.status === 'complete') for (const row of existing) if (!incoming.has(row.key)) incoming.set(row.key, null);
    let changed = 0, conflicts = 0;
    for (const [key, next] of incoming) {
      const old = previous.get(key), before = old?.source_json ?? null, target = old?.target_json ?? null;
      let nextTarget = target;
      if (!old || target === before || target === next) nextTarget = next;
      else if (next !== before) {
        this.db.prepare('INSERT INTO conflicts VALUES(?,?,?,?,?)').run(snapshot.snapshotId, key, before, target, next);
        conflicts++;
      }
      if (nextTarget !== target) changed++;
      this.db.prepare(`INSERT INTO objects VALUES(?,?,?,?,?) ON CONFLICT(source,scope,key)
        DO UPDATE SET source_json=excluded.source_json,target_json=excluded.target_json`)
        .run(snapshot.sourceId, snapshot.scope, key, next, nextTarget);
    }
    this.db.prepare(`INSERT INTO heads VALUES(?,?,?,?) ON CONFLICT(source,scope)
      DO UPDATE SET head=excluded.head,coverage=excluded.coverage`).run(snapshot.sourceId, snapshot.scope, snapshot.snapshotId, coverage);
    this.db.prepare('UPDATE snapshots SET applied=1 WHERE id=?').run(snapshot.snapshotId);
    return { status: 'imported', changed, conflicts };
  }

  get(sourceId, scope, key) {
    const row = this.db.prepare('SELECT source_json,target_json FROM objects WHERE source=? AND scope=? AND key=?').get(sourceId, scope, key);
    if (!row) return undefined;
    return { sourceDeleted: row.source_json === null, targetDeleted: row.target_json === null,
      source: row.source_json === null ? undefined : JSON.parse(row.source_json),
      target: row.target_json === null ? undefined : JSON.parse(row.target_json) };
  }

  edit(sourceId, scope, key, value) {
    const result = this.db.prepare('UPDATE objects SET target_json=? WHERE source=? AND scope=? AND key=?')
      .run(canonical(value), sourceId, scope, key);
    if (result.changes !== 1) throw new Error('TARGET_NOT_FOUND');
  }

  conflicts() { return this.db.prepare('SELECT * FROM conflicts ORDER BY snapshot,key').all(); }
}
