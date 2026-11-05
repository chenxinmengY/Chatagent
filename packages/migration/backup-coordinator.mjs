import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { retentionPlan } from './retention.mjs';

const day = time => new Date(time + 8 * 3600000).toISOString().slice(0, 10);

// 仅调度调用方提供的捕获器，不读生产目录、不删备份、不安装系统任务。
export class BackupCoordinator {
  constructor({ file, capture, isIdle, now = Date.now, enabled = false, retryMs = 10 * 60000 }) {
    if (!path.isAbsolute(file) || typeof capture !== 'function' || typeof isIdle !== 'function' || !Number.isSafeInteger(retryMs) || retryMs < 1) throw Error('INVALID_BACKUP_COORDINATOR');
    if (fs.realpathSync(path.dirname(file)).toLowerCase() !== path.dirname(file).toLowerCase() || fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw Error('BACKUP_STATE_LINK_REFUSED');
    this.file = file; this.capture = capture; this.isIdle = isIdle; this.now = now; this.enabled = enabled; this.retryMs = retryMs; this.job = null;
    this.state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { format: 'chatagent-backup-jobs-v1', attempts: [], snapshots: [] };
    if (this.state.format !== 'chatagent-backup-jobs-v1' || !Array.isArray(this.state.attempts) || !Array.isArray(this.state.snapshots)) throw Error('INVALID_BACKUP_STATE');
    for (const attempt of this.state.attempts) if (attempt.state === 'capturing') { attempt.state = 'interrupted'; attempt.error = 'CAPTURE_INTERRUPTED'; }
    this.save();
  }
  save() {
    const temporary = this.file + '.' + randomUUID() + '.tmp';
    const fd = fs.openSync(temporary, 'wx'); try { fs.writeFileSync(fd, JSON.stringify(this.state, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.file);
  }
  status() { return structuredClone({ enabled: this.enabled, running: Boolean(this.job), lastAttempt: this.state.attempts.at(-1) ?? null,
    lastComplete: this.state.snapshots.filter(item => item.status === 'complete' && item.published).at(-1) ?? null, retention: retentionPlan(this.state.snapshots) }); }
  request(kind = 'manual') {
    if (!['manual', 'automatic'].includes(kind)) return Promise.reject(Error('INVALID_BACKUP_KIND'));
    if (this.job) return this.job;
    const attempt = { id: randomUUID(), kind, startedAt: this.now(), state: 'capturing' };
    this.state.attempts.push(attempt); this.save();
    this.job = Promise.resolve().then(() => this.capture()).then(manifest => {
      if (manifest?.status !== 'complete' || typeof manifest.id !== 'string' || !Array.isArray(manifest.coverage) || !manifest.coverage.length) throw Error('BACKUP_NOT_COMPLETE');
      const record = { id: manifest.id, kind, createdAt: manifest.createdAt ?? this.now(), status: 'complete', published: true, pinned: false, restoreVerified: false, coverage: manifest.coverage };
      if (this.state.snapshots.some(item => item.id === record.id)) throw Error('DUPLICATE_BACKUP_PUBLICATION');
      this.state.snapshots.push(record); attempt.state = 'published'; attempt.finishedAt = this.now(); attempt.snapshotId = record.id; this.save(); return manifest;
    }).catch(error => { attempt.state = 'failed'; attempt.finishedAt = this.now(); attempt.error = /^[A-Z_]+$/.test(error.message ?? '') ? error.message : 'CAPTURE_FAILED'; this.save(); throw error; })
      .finally(() => { this.job = null; });
    return this.job;
  }
  async tick() {
    if (!this.enabled || this.job || !this.isIdle()) return null;
    const today = day(this.now());
    if (this.state.snapshots.some(item => item.status === 'complete' && item.published && day(item.createdAt) === today)) return null;
    const attempts = this.state.attempts.filter(item => item.kind === 'automatic' && day(item.startedAt) === today);
    if (attempts.length >= 3 || attempts.length && this.now() - (attempts.at(-1).finishedAt ?? attempts.at(-1).startedAt) < this.retryMs) return null;
    return this.request('automatic');
  }
  pin(id, pinned) { const item = this.state.snapshots.find(item => item.id === id); if (!item || typeof pinned !== 'boolean') throw Error('INVALID_BACKUP_PIN'); item.pinned = pinned; this.save(); }
}
