import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {beijing, nextDue, scheduleFrom, GRACE} from './time.mjs';

export const hash = value => crypto.createHash('sha256').update(value).digest('hex');
export const accountId = value => /^[a-f0-9]{64}$/.test(value ?? '') ? value : hash(String(value));
export const displayId = id => 'R' + String(id).padStart(2, '0');
const pending = "('pending','retry')";
const publicOccurrence = o => o ? {id: o.id, due: beijing(o.due), status: o.status, text: o.text} : null;

export class ReminderStore {
  constructor(root, account) {
    if (!account || account === 'unbound') throw Error('提醒需要绑定微信账号');
    this.account = accountId(account);
    const base = path.resolve(root), directory = path.join(base, 'state/reminders', this.account);
    for (let current = directory; current !== path.dirname(base); current = path.dirname(current)) {
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error('提醒目录不能是链接');
      if (current === base) break;
    }
    fs.mkdirSync(directory, {recursive: true});
    const file = path.join(directory, 'reminders.sqlite');
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw Error('提醒数据库不能是链接');
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS plans(id INTEGER PRIMARY KEY AUTOINCREMENT,chat TEXT NOT NULL,text TEXT NOT NULL,phrase TEXT NOT NULL,schedule TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,state TEXT NOT NULL DEFAULT 'active',next_due INTEGER,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS plan_chat ON plans(chat,state);
      CREATE TABLE IF NOT EXISTS occurrences(id TEXT PRIMARY KEY,plan INTEGER NOT NULL,version INTEGER NOT NULL,chat TEXT NOT NULL,due INTEGER NOT NULL,text TEXT NOT NULL,phrase TEXT NOT NULL,status TEXT NOT NULL,batch TEXT,parent TEXT,updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS occurrence_due ON occurrences(status,due);
      CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,chat TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0);`);
  }
  tx(fn) {this.db.exec('BEGIN IMMEDIATE'); try {const value = fn(); this.db.exec('COMMIT'); return value;} catch (error) {this.db.exec('ROLLBACK'); throw error;}}
  get(sql, ...args) {return this.db.prepare(sql).get(...args);}
  all(sql, ...args) {return this.db.prepare(sql).all(...args);}
  run(sql, ...args) {return this.db.prepare(sql).run(...args);}
  close() {this.db.close();}
  plans(chat) {return this.all('SELECT * FROM plans WHERE chat=? ORDER BY id', chat);}
  view(plan) {
    const next = this.get(`SELECT * FROM occurrences WHERE plan=? AND status IN ${pending} ORDER BY due LIMIT 1`, plan.id);
    const last = this.get('SELECT * FROM occurrences WHERE plan=? ORDER BY due DESC LIMIT 1', plan.id);
    const due = next && (!plan.next_due || next.due < plan.next_due) ? next.due : plan.next_due;
    return {id: displayId(plan.id), text: plan.text, schedule: JSON.parse(plan.schedule), state: plan.state,
      next: due ? beijing(due) : null, version: plan.version, recentOccurrence: publicOccurrence(last)};
  }
  select(chat, args) {
    let list = this.plans(chat);
    if (args.planId) list = list.filter(p => displayId(p.id) === args.planId.toUpperCase());
    else list = list.filter(p => args.includeInactive || p.state === 'active' || (['snooze', 'update'].includes(args.action) && p.state === 'completed'));
    if (args.query) list = list.filter(p => p.text.includes(args.query.trim()));
    if (args.kind === 'once') list = list.filter(p => JSON.parse(p.schedule).kind === 'once');
    if (args.kind === 'repeating') list = list.filter(p => JSON.parse(p.schedule).kind !== 'once');
    return list;
  }
  occurrence(plan, due, now, override = {}) {
    const id = hash(JSON.stringify([this.account, plan.chat, plan.id, plan.version, due, override.parent ?? 'regular']));
    this.run('INSERT OR IGNORE INTO occurrences(id,plan,version,chat,due,text,phrase,status,parent,updated) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id, plan.id, plan.version, plan.chat, due, override.text ?? plan.text, override.phrase ?? plan.phrase, 'pending', override.parent ?? null, now);
    return this.get('SELECT * FROM occurrences WHERE id=?', id);
  }
  materialize(chat, now) {
    for (const plan of this.all("SELECT * FROM plans WHERE chat=? AND state='active' AND next_due<=?", chat, now)) {
      const schedule = JSON.parse(plan.schedule);
      let due = plan.next_due, count = 0;
      while (due !== null && due <= now && count++ < 4000) {
        const occurrence = this.occurrence(plan, due, now);
        if (now > due + GRACE && ['pending', 'retry'].includes(occurrence.status)) this.run("UPDATE occurrences SET status='missed',updated=? WHERE id=?", now, occurrence.id);
        due = nextDue(schedule, due + 1);
      }
      this.run('UPDATE plans SET next_due=? WHERE id=?', due, plan.id);
    }
    this.run(`UPDATE occurrences SET status='missed',updated=? WHERE chat=? AND status IN ${pending} AND due<?`, now, chat, now - GRACE);
    this.complete(chat, now);
  }
  complete(chat, now) {
    this.run(`UPDATE plans SET state='completed',updated=? WHERE chat=? AND state='active' AND next_due IS NULL AND NOT EXISTS(SELECT 1 FROM occurrences WHERE plan=plans.id AND status IN ('pending','retry','dispatching'))`, now, chat);
  }
  target(plan, now, occurrenceId) {
    this.materialize(plan.chat, now);
    if (occurrenceId) return this.get('SELECT * FROM occurrences WHERE id=? AND plan=?', occurrenceId, plan.id);
    const delayed = this.get(`SELECT * FROM occurrences WHERE plan=? AND parent IS NOT NULL AND status IN ${pending} ORDER BY due LIMIT 1`, plan.id);
    if (delayed) return delayed;
    const todayStart = Date.parse(beijing(now).slice(0, 10) + 'T00:00:00+08:00');
    const recent = this.get("SELECT * FROM occurrences WHERE plan=? AND parent IS NULL AND due>=? AND due<=? AND status NOT IN ('cancelled','skipped','snoozed') ORDER BY due DESC LIMIT 1", plan.id, todayStart, now);
    if (recent) return recent;
    const future = this.get(`SELECT * FROM occurrences WHERE plan=? AND status IN ${pending} ORDER BY due LIMIT 1`, plan.id);
    if (future) return future;
    const fresh = this.get('SELECT * FROM plans WHERE id=?', plan.id);
    return fresh.next_due ? this.occurrence(fresh, fresh.next_due, now) : null;
  }
  advanceIfNeeded(plan, due) {
    const fresh = this.get('SELECT * FROM plans WHERE id=?', plan.id);
    if (fresh.next_due === due) this.run('UPDATE plans SET next_due=? WHERE id=?', nextDue(JSON.parse(fresh.schedule), due + 1), plan.id);
  }
  manage(chat, args, now) {
    if (!/^wechat:private:[1-9]\d*$/.test(chat)) throw Error('事项提醒仅支持当前授权私聊');
    return this.tx(() => {
      if (args.action === 'list') {
        const plans = this.select(chat, args).filter(p => args.includeInactive || p.state === 'active');
        const offset = args.offset ?? 0;
        if (!Number.isInteger(offset) || offset < 0) throw Error('列表页码无效');
        const page = plans.slice(offset, offset + 8);
        return {status: 'ok', plans: page.map(p => this.view(p)), total: plans.length, offset,
          nextOffset: offset + page.length < plans.length ? offset + page.length : null,
          recent: this.all('SELECT * FROM occurrences WHERE chat=? ORDER BY due DESC LIMIT 5', chat).map(o => ({planId: displayId(o.plan), ...publicOccurrence(o)}))};
      }
      if (args.action === 'create') {
        const text = String(args.text ?? '').trim(), phrase = String(args.phrase ?? text).trim();
        if (!text || text.length > 300 || !phrase || phrase.length > 600) throw Error('提醒事项或措辞无效');
        const schedule = scheduleFrom(args, now), serialized = JSON.stringify(schedule), due = nextDue(schedule, now + 1);
        const duplicate = this.plans(chat).find(p => {
          if (p.state !== 'active' || p.text !== text) return false;
          const other = JSON.parse(p.schedule);
          return p.schedule === serialized || schedule.kind !== 'once' && other.kind === schedule.kind &&
            other.time === schedule.time && other.end === schedule.end && JSON.stringify(other.weekdays) === JSON.stringify(schedule.weekdays) && nextDue(other, now + 1) === due;
        });
        if (duplicate) return {status: 'already_exists', plan: this.view(duplicate)};
        if (this.get("SELECT count(*) AS n FROM plans WHERE chat=? AND state='active'", chat).n >= 100) throw Error('最多保留100项有效提醒，请先取消不需要的计划');
        const id = Number(this.run('INSERT INTO plans(chat,text,phrase,schedule,next_due,created,updated) VALUES(?,?,?,?,?,?,?)', chat, text, phrase, serialized, due, now, now).lastInsertRowid);
        return {status: 'created', plan: this.view(this.get('SELECT * FROM plans WHERE id=?', id))};
      }
      const matches = this.select(chat, args);
      if (!args.planId && !args.query && !args.all) return {status: 'needs_clarification', message: '请明确提醒事项或列表中的编号', plans: matches.slice(0, 8).map(p => this.view(p)), total: matches.length};
      if (!matches.length) return {status: 'not_found', message: '没有找到对应提醒'};
      if (matches.length !== 1 && !(args.action === 'cancel' && args.all === true && !args.query && !args.planId)) return {status: 'needs_clarification', message: '有多条相近提醒，请用编号明确选择', plans: matches.slice(0, 8).map(p => this.view(p)), total: matches.length};
      if (args.all && args.action !== 'cancel') throw Error('仅明确取消全部时可用 all');
      if (args.action === 'cancel') {
        let inFlight = 0;
        for (const p of matches) {
          inFlight += this.get("SELECT count(*) AS n FROM occurrences WHERE plan=? AND status='dispatching'", p.id).n;
          this.run("UPDATE plans SET state='cancelled',next_due=NULL,updated=? WHERE id=?", now, p.id);
          this.run(`UPDATE occurrences SET status='cancelled',updated=? WHERE plan=? AND status IN ${pending}`, now, p.id);
        }
        return {status: 'cancelled', ids: matches.map(p => displayId(p.id)), inFlight,
          message: inFlight ? '后续提醒已取消；正在提交的提醒可能已发出，无法承诺撤回' : '已取消，后续及尚未发出的延后提醒均停止'};
      }
      const plan = matches[0], schedule = JSON.parse(plan.schedule);
      if (plan.state === 'cancelled') return {status: 'not_found', message: '该计划已取消，请重新设置'};
      if (args.action === 'update' && schedule.kind !== 'once' && !args.scope) return {status: 'needs_clarification', message: '是仅修改这次，还是修改以后所有轮次？'};
      if (args.action === 'update' && args.scope === 'series' && schedule.kind !== 'once') {
        const nextSchedule = scheduleFrom(args, now, schedule);
        const text = args.text?.trim() ?? plan.text, phrase = args.phrase?.trim() ?? (args.text ? text : plan.phrase);
        if (!text || text.length > 300 || !phrase || phrase.length > 600) throw Error('提醒内容无效');
        if (JSON.stringify(nextSchedule) === plan.schedule && text === plan.text && phrase === plan.phrase) return {status: 'unchanged', plan: this.view(plan)};
        this.run(`UPDATE occurrences SET status='cancelled',updated=? WHERE plan=? AND status IN ${pending}`, now, plan.id);
        this.run("UPDATE plans SET schedule=?,text=?,phrase=?,version=version+1,next_due=?,state='active',updated=? WHERE id=?", JSON.stringify(nextSchedule), text, phrase, nextDue(nextSchedule, now + 1), now, plan.id);
        return {status: 'updated', plan: this.view(this.get('SELECT * FROM plans WHERE id=?', plan.id))};
      }
      if (!['update', 'skip', 'snooze'].includes(args.action)) throw Error('未知提醒操作');
      const occurrence = this.target(plan, now, args.occurrenceId);
      if (!occurrence) return {status: 'not_found', message: '没有可修改的提醒轮次'};
      if (occurrence.status === 'dispatching') return {status: 'in_flight', message: '这轮提醒正在提交，无法保证撤回；可以明确设置新的提醒'};
      if (args.action === 'skip') {
        if (['confirmed', 'unconfirmed'].includes(occurrence.status)) return {status: 'already_dispatched', message: '该轮已提交，无法撤回'};
        this.run("UPDATE occurrences SET status='skipped',updated=? WHERE id=?", now, occurrence.id);
        this.run(`UPDATE occurrences SET status='cancelled',updated=? WHERE parent=? AND status IN ${pending}`, now, occurrence.id);
        this.advanceIfNeeded(plan, occurrence.due); this.complete(chat, now);
        return {status: 'skipped', plan: this.view(this.get('SELECT * FROM plans WHERE id=?', plan.id))};
      }
      const targetSchedule = scheduleFrom({...args, repeat: 'once', date: args.date ?? (args.time ? beijing(occurrence.due).slice(0, 10) : undefined)}, now,
        args.delayMinutes !== undefined ? null : {kind: 'once', at: occurrence.due});
      const text = args.text?.trim() ?? occurrence.text, phrase = args.phrase?.trim() ?? (args.text ? text : occurrence.phrase);
      if (!text || text.length > 300 || !phrase || phrase.length > 600) throw Error('提醒内容无效');
      this.advanceIfNeeded(plan, occurrence.due);
      this.run(`UPDATE occurrences SET status='snoozed',updated=? WHERE (id=? OR parent=?) AND status IN ${pending}`, now, occurrence.id, occurrence.id);
      const next = this.occurrence(plan, targetSchedule.at, now, {parent: occurrence.id, text, phrase});
      this.run("UPDATE plans SET state='active',updated=? WHERE id=?", now, plan.id);
      if (schedule.kind === 'once') this.run('UPDATE plans SET text=?,phrase=?,schedule=? WHERE id=?', text, phrase, JSON.stringify(targetSchedule), plan.id);
      return {status: 'rescheduled', occurrence: publicOccurrence(next), plan: this.view(this.get('SELECT * FROM plans WHERE id=?', plan.id))};
    });
  }
}
