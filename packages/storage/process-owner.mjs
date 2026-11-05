import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// A PID can be reused after a reboot or process exit. Never terminate the new
// process, and never treat an unverified timestamp as proof of a stale owner.
export function windowsProcessBirth(pid) {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const value = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[DateTimeOffset]::new((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()`], { windowsHide: true, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return /^\d+$/.test(value) ? Number(value) : null;
  } catch { return null; }
}
let ownBirth;
export function ownerRecord(token) { ownBirth ??= windowsProcessBirth(process.pid); return { pid: process.pid, token, ...(ownBirth ? { birthMs: ownBirth } : {}) }; }
export function ownerDefinitelyGone(record, file, { probe = pid => process.kill(pid, 0), birth = windowsProcessBirth, modified = name => fs.statSync(name).mtimeMs } = {}) {
  try { probe(record.pid); } catch (error) { return error.code === 'ESRCH'; }
  const started = birth(record.pid);
  if (!Number.isFinite(started) || started <= 0) return false;
  if (Number.isFinite(record.birthMs) && record.birthMs > 0) return started !== record.birthMs;
  // Legacy lock: the current process was created after that lock was written.
  // Allow one second for filesystem timestamp precision, otherwise fail closed.
  return started > modified(file) + 1000;
}
