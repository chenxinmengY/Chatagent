import fs from 'node:fs';
import path from 'node:path';
import {ReminderStore, accountId} from './store.mjs';
import {ReminderScheduler} from './scheduler.mjs';

export function createReminderBinding({root, account, allowed, ready, probe = async () => true, send, record, now = Date.now, log}) {
  const scope = accountId(account), store = new ReminderStore(root, scope);
  const statusFile = path.join(root, 'state/reminders/host-status.json');
  const heartbeat = online => {
    const temporary = statusFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({version: 1, online, account: scope, pid: process.pid, at: now()}));
    fs.renameSync(temporary, statusFile);
  };
  const scheduler = new ReminderScheduler({store, now, allowed, ready, send, archive: record, log});
  heartbeat(true);
  return {
    async tick() {heartbeat(true); const online = await probe().catch(() => false); scheduler.ready = key => online && ready(key); await scheduler.tick();},
    async close() {heartbeat(false); await scheduler.close();},
    get busy() {return !!scheduler.running;}
  };
}
