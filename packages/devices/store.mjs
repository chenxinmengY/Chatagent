import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fault } from '../conversation/store.mjs';

const APPLICATION_ID = 0x43414456;
const secret = () => randomBytes(32).toString('hex');
const digest = value => createHash('sha256').update(value).digest('hex');
const validSecret = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const PAIRING_LIFETIME_MS = 5 * 60000;

// 独立于聊天档案：正常重启保留授权，恢复档案必须重新配对。
export class DeviceStore {
  constructor(file, { now = Date.now } = {}) {
    if (!path.isAbsolute(file) || fs.realpathSync(path.dirname(file)).toLowerCase() !== path.dirname(file).toLowerCase()) throw fault('ISOLATED_PATH_REQUIRED');
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(file + suffix) && fs.lstatSync(file + suffix).isSymbolicLink()) throw fault('DATABASE_LINK_REFUSED');
    if (fs.existsSync(file)) {
      const probe = new DatabaseSync(file, { readOnly: true });
      try { if (probe.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID) throw fault('FOREIGN_DATABASE_REFUSED'); }
      finally { probe.close(); }
    } else fs.closeSync(fs.openSync(file, 'wx'));
    this.now = now;
    this.db = new DatabaseSync(file);
    try {
      this.db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
        CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL, revoked_at INTEGER);
        CREATE TABLE IF NOT EXISTS pairing(slot INTEGER PRIMARY KEY CHECK(slot=1), secret_hash TEXT NOT NULL,
          expires_at INTEGER NOT NULL, device_id TEXT);`);
      // 未完成的邀请不跨进程重启存活；已登记设备独立保留。
      this.db.exec('DELETE FROM pairing');
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  invite() {
    const credential = secret(), expiresAt = this.now() + PAIRING_LIFETIME_MS;
    this.db.prepare('INSERT OR REPLACE INTO pairing VALUES(1,?,?,NULL)').run(digest(credential), expiresAt);
    return { credential, expiresAt };
  }
  cancelInvitation() { this.db.exec('DELETE FROM pairing'); }
  claim({ credential, deviceToken, name }) {
    if (!validSecret(credential) || !validSecret(deviceToken) || credential === deviceToken ||
        typeof name !== 'string' || !name.trim() || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw fault('INVALID_PAIRING', 400);
    return this.transaction(() => {
      const invite = this.db.prepare('SELECT * FROM pairing WHERE slot=1 AND secret_hash=?').get(digest(credential));
      if (!invite || invite.expires_at <= this.now()) throw fault('PAIRING_UNAVAILABLE', 403);
      const hash = digest(deviceToken);
      if (invite.device_id) {
        const device = this.db.prepare('SELECT * FROM devices WHERE id=?').get(invite.device_id);
        // 响应丢失只允许同一设备凭据重试，不再签发第二个身份。
        if (!device || device.revoked_at !== null || device.token_hash !== hash || device.name !== name.trim()) throw fault('PAIRING_UNAVAILABLE', 403);
        return { deviceId: device.id, name: device.name };
      }
      if (this.db.prepare('SELECT 1 FROM devices WHERE token_hash=?').get(hash)) throw fault('DEVICE_TOKEN_REUSED', 409);
      const id = randomUUID();
      this.db.prepare('INSERT INTO devices VALUES(?,?,?,?,NULL)').run(id, name.trim(), hash, this.now());
      this.db.prepare('UPDATE pairing SET device_id=? WHERE slot=1').run(id);
      return { deviceId: id, name: name.trim() };
    });
  }
  authenticate(token) {
    if (!validSecret(token)) throw fault('DEVICE_AUTH_REQUIRED', 401);
    const row = this.db.prepare('SELECT id,name FROM devices WHERE token_hash=? AND revoked_at IS NULL').get(digest(token));
    if (!row) throw fault('DEVICE_AUTH_REQUIRED', 401);
    return { deviceId: row.id, name: row.name };
  }
  list() { return this.db.prepare('SELECT id,name,created_at,revoked_at FROM devices ORDER BY created_at,id').all(); }
  revoke(id) {
    if (typeof id !== 'string' || !this.db.prepare('SELECT 1 FROM devices WHERE id=?').get(id)) throw fault('DEVICE_NOT_FOUND', 404);
    this.db.prepare('UPDATE devices SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(this.now(), id);
    return { deviceId: id, revoked: true };
  }
}
