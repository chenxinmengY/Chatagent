import {hash} from './store.mjs';
import {beijing, GRACE, MINUTE} from './time.mjs';

export class ReminderScheduler {
  constructor({store, now = Date.now, allowed, ready, send, archive = () => {}, log = () => {}}) {
    Object.assign(this, {store, now, allowed, ready, send, archive, log});
    this.closed = false;
    // A previously claimed submission has an unknown outcome after a crash.
    // Never turn it back into a fresh, sendable occurrence.
    store.tx(() => {
      store.run("UPDATE batches SET status='unconfirmed',updated=? WHERE status='dispatching'", now());
      store.run("UPDATE occurrences SET status='unconfirmed',updated=? WHERE status='dispatching'", now());
    });
  }
  async tick() {
    if (this.closed || this.running) return;
    this.running = this.work().catch(error => this.log('tick_failed ' + (error.code ?? error.message))).finally(() => {this.running = null;});
    return this.running;
  }
  async flushArchives() {
    for (const batch of this.store.all("SELECT * FROM batches WHERE status IN ('confirmed','unconfirmed') AND archived=0 ORDER BY created LIMIT 50")) {
      if (!this.allowed(batch.chat)) continue;
      try {
        await this.archive(batch);
        this.store.run('UPDATE batches SET archived=1 WHERE id=?', batch.id);
      } catch {this.log('history_pending');}
    }
  }
  async work() {
    await this.flushArchives();
    const store = this.store;
    const chats = store.all("SELECT DISTINCT chat FROM plans WHERE state='active' UNION SELECT DISTINCT chat FROM occurrences WHERE status IN ('pending','retry')").map(x => x.chat);
    for (const chat of chats) {
      if (this.closed || !this.allowed(chat)) continue;
      const now = this.now();
      store.tx(() => store.materialize(chat, now));
      if (!this.ready(chat)) continue;
      for (let count = 0; count < 20 && !this.closed; count++) {
        // No async boundary between the final scope check, claim, and send call.
        if (!this.allowed(chat) || !this.ready(chat)) break;
        const batch = store.tx(() => {
          const current = this.now();
          store.materialize(chat, current);
          const first = store.get("SELECT * FROM occurrences WHERE chat=? AND status IN ('pending','retry') AND due<=? AND updated<=? ORDER BY due,id LIMIT 1", chat, current, current);
          if (!first) return null;
          const start = Math.floor(first.due / MINUTE) * MINUTE;
          const items = store.all("SELECT o.* FROM occurrences o JOIN plans p ON p.id=o.plan WHERE o.chat=? AND o.status IN ('pending','retry') AND o.due>=? AND o.due<? AND o.due<=? AND o.updated<=? AND p.state!='cancelled' ORDER BY o.plan,o.id", chat, start, start + MINUTE, current, current);
          if (!items.length) return null;
          const late = current - first.due >= MINUTE;
          const heading = late ? `提醒晚了一点（原定${beijing(first.due).replace('T', ' ')}）：` : '到时间啦，记得：';
          // Keep a merged message within WeChat's verified text-send bound.
          const selected = []; let length = heading.length;
          for (const item of items) {if (length + item.phrase.length + 4 > 3500 && selected.length) break; selected.push(item); length += item.phrase.length + 4;}
          const text = heading + '\n' + selected.map((o, i) => selected.length > 1 ? `${i + 1}. ${o.phrase}` : o.phrase).join('\n');
          const id = hash(JSON.stringify([this.store.account, chat, selected.map(x => x.id), text]));
          store.run("INSERT INTO batches(id,chat,text,status,created,updated) VALUES(?,?,?,'dispatching',?,?) ON CONFLICT(id) DO UPDATE SET status='dispatching',updated=excluded.updated", id, chat, text, current, current);
          for (const item of selected) store.run("UPDATE occurrences SET status='dispatching',batch=?,updated=? WHERE id=? AND status IN ('pending','retry')", id, current, item.id);
          return {id, chat, text};
        });
        if (!batch) break;
        try {
          const response = await this.send(batch);
          const confirmed = response?.confirmed === true && response?.delivered === 'database-confirmed';
          this.finish(batch, confirmed ? 'confirmed' : 'unconfirmed');
        } catch (error) {
          // Only a definite rejection BEFORE native submission may be retried.
          const beforeDispatchUnavailable = /^(READER|HOOK)_(NOT_LISTENING|HEALTH_TIMEOUT|CONNECTION_RESET|HEALTH_FAILED|NOT_READY)$/.test(error.code ?? '');
          const busy = (error.code === 'SENDER_BUSY' || beforeDispatchUnavailable) && error.data?.attempted !== true;
          if (busy) {
            store.tx(() => {
              store.run("UPDATE batches SET status='rejected',updated=? WHERE id=?", this.now(), batch.id);
              store.run("UPDATE occurrences SET status='retry',batch=NULL,updated=? WHERE batch=? AND status='dispatching'", this.now() + 5000, batch.id);
            });
            break;
          }
          this.finish(batch, 'unconfirmed');
        }
        await this.flushArchives();
      }
    }
  }
  finish(batch, status) {
    this.store.tx(() => {
      this.store.run('UPDATE batches SET status=?,updated=? WHERE id=?', status, this.now(), batch.id);
      this.store.run("UPDATE occurrences SET status=?,updated=? WHERE batch=? AND status IN ('dispatching','unconfirmed')", status, this.now(), batch.id);
      this.store.complete(batch.chat, this.now());
    });
  }
  async close() {this.closed = true; await this.running; this.store.close();}
}
