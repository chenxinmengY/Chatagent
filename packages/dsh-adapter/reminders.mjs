import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 仅由隔离演练显式构造；默认启动不启用。源任务只保留，不因导入到期重放。
export async function createStandbyReminders({ companion, chatStore, now = Date.now }) {
  const load = name => import(pathToFileURL(path.join(companion.root, 'plugins/daily-reminders/lib', name + '.mjs')).href);
  const [{ ReminderStore }, { ReminderScheduler }] = await Promise.all([load('store'), load('scheduler')]);
  const store = new ReminderStore(companion.root, companion.capsule.account);
  store.tx(() => {
    store.db.exec('CREATE TABLE IF NOT EXISTS chatagent_quarantine(id INTEGER PRIMARY KEY CHECK(id=1),at INTEGER NOT NULL)');
    if (!store.get('SELECT 1 FROM chatagent_quarantine')) {
      store.run("UPDATE plans SET state='paused' WHERE state='active'");
      store.run("UPDATE occurrences SET status='paused' WHERE status IN ('pending','retry')");
      store.run('INSERT INTO chatagent_quarantine VALUES(1,?)', now());
    }
  });
  let enabled = true;
  const statusFile = path.join(companion.root, 'state/reminders/host-status.json');
  const heartbeat = () => fs.writeFileSync(statusFile, JSON.stringify({ online: enabled, account: companion.capsule.account, at: now(), destination: 'chatagent-local-store' }));
  const scheduler = new ReminderScheduler({ store, now, allowed: key => enabled && key === companion.capsule.key, ready: () => enabled,
    send: async batch => {
      const message = chatStore.publish({ deliveryId: batch.id, text: batch.text });
      if (chatStore.message(message.id)?.state !== 'completed') throw Error('LOCAL_DELIVERY_UNPROVEN');
      // 旧scheduler的database-confirmed仅在这个适配边界表示电脑SQLite提交成功。
      return { confirmed: true, delivered: 'database-confirmed', deviceReceived: false };
    } });
  heartbeat();
  return { heartbeat, async tick() { heartbeat(); await scheduler.tick(); }, async close() { enabled = false; heartbeat(); await scheduler.close(); } };
}
