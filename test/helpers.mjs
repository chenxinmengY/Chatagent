import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ImportStore } from '../packages/migration/import-store.mjs';
import { makeSnapshot } from '../packages/migration/snapshot.mjs';

export function sandbox(t) {
  const base = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'chatagent-verification-'));
  fs.writeFileSync(path.join(root, '.owned-test-directory'), 'chatagent-synthetic-only');
  const handles = [];
  t.after(() => {
    for (const handle of handles.reverse()) handle.close();
    const resolved = fs.realpathSync(root);
    if (path.dirname(resolved).toLowerCase() !== base.toLowerCase() || !path.basename(resolved).startsWith('chatagent-verification-') ||
      fs.readFileSync(path.join(resolved, '.owned-test-directory'), 'utf8') !== 'chatagent-synthetic-only') throw new Error('CLEANUP_BOUNDARY_INVALID');
    fs.rmSync(resolved, { recursive: true });
  });
  return { root,
    database(name) { const db = new DatabaseSync(path.join(root, name)); handles.push(db); return db; },
    store(name = 'target.sqlite') { const store = new ImportStore(path.join(root, name)); handles.push(store); return store; } };
}

export function fixture(objects, options = {}) {
  return makeSnapshot({ sourceId: 'synthetic-source', scope: 'synthetic-workspace', coverage: ['messages', 'plugin-data'],
    objects: Object.entries(objects).map(([key, value]) => ({ key, value })), ...options });
}

export function get(store, key) { return store.get('synthetic-source', 'synthetic-workspace', key); }
