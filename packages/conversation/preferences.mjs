import { randomUUID } from 'node:crypto';
import { fault } from './store.mjs';
import {DEFAULT_WINDOW_POLICY,windowPolicy} from './window-policy.mjs';

export const DEFAULT_POLICY = Object.freeze({ ...DEFAULT_WINDOW_POLICY, disabledTools: [], maxMessages: 2, mergeMs: 0, minIntervalMs: 0, contextEnabled: false, contextMaxTokens: 100000, contextIdleSeconds: 60, proactiveEnabled:false, proactiveSchedule:'after-message', proactiveMode:'mixed', proactiveJitterMinutes:0, proactiveIdleMinutes:60, proactiveMinIntervalMinutes:180, proactiveMaxPerDay:3, quietStart:22, quietEnd:8, quietStartMinute:0, quietEndMinute:0 });
const modes = ['social', 'assistant'];
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const name = value => typeof value === 'string' && value.trim() && value.length <= 80 && !/[\x00-\x1f]/.test(value);
export function validatePreferences(value) {
  if (!plain(value) || !plain(value.policy) || !plain(value.modes) || !Array.isArray(value.personas) || !Array.isArray(value.groups) || !Array.isArray(value.categories)) throw fault('INVALID_PREFERENCES', 400);
  const p = value.policy;
  if(!['after-message','periodic'].includes(p.proactiveSchedule??'after-message')||!['mixed','greeting','news','meme'].includes(p.proactiveMode??'mixed')||!integer(p.proactiveJitterMinutes??0,0,60))throw fault('INVALID_CHAT_POLICY',400);
  try{windowPolicy(p);}catch{throw fault('INVALID_CHAT_POLICY',400);}
  if(value.capabilities!==undefined){
    const cards=value.capabilities;
    if(!Array.isArray(cards)||cards.length>50||Buffer.byteLength(JSON.stringify(cards))>65536||new Set(cards.map(c=>c?.id)).size!==cards.length)throw fault('INVALID_CAPABILITIES',400);
    for(const c of cards){if(!plain(c)||!/^[-a-zA-Z0-9_]{1,80}$/.test(c.id??'')||!name(c.name)||typeof c.description!=='string'||c.description.length>2000||!Array.isArray(c.fields)||c.fields.length>40||!plain(c.values)||new Set(c.fields.map(f=>f?.key)).size!==c.fields.length)throw fault('INVALID_CAPABILITIES',400);
      for(const f of c.fields)if(!plain(f)||!/^[-a-zA-Z0-9_]{1,80}$/.test(f.key??'')||['__proto__','constructor','prototype'].includes(f.key)||!name(f.label)||!['string','number','boolean'].includes(f.type))throw fault('INVALID_CAPABILITIES',400);
      for(const [key,v] of Object.entries(c.values)){const f=c.fields.find(f=>f.key===key);if(!f||typeof v!==f.type||typeof v==='number'&&!Number.isFinite(v)||typeof v==='string'&&v.length>8000)throw fault('INVALID_CAPABILITIES',400);}
    }
  }
  if(p.disabledTools!==undefined&&(!Array.isArray(p.disabledTools)||p.disabledTools.length>300||p.disabledTools.some(n=>typeof n!=="string"||!/^[-a-zA-Z0-9_.:]+$/.test(n))))throw fault("INVALID_CHAT_POLICY",400);
  if(typeof p.proactiveEnabled!=='boolean'||!integer(p.proactiveIdleMinutes,1,10080)||!integer(p.proactiveMinIntervalMinutes,1,10080)||!integer(p.proactiveMaxPerDay,0,24)||!integer(p.quietStart,0,23)||!integer(p.quietEnd,0,23)||!integer(p.quietStartMinute??0,0,59)||!integer(p.quietEndMinute??0,0,59))throw fault('INVALID_CHAT_POLICY',400);
  if (Object.keys(p).some(k => !Object.hasOwn(DEFAULT_POLICY, k)) || !integer(p.maxMessages, 0, 20) || !integer(p.mergeMs, 0, 60000) || !integer(p.minIntervalMs, 0, 60000) || typeof p.contextEnabled !== 'boolean' || !integer(p.contextMaxTokens, 4000, 2000000) || !integer(p.contextIdleSeconds, 15, 3600)) throw fault('INVALID_CHAT_POLICY', 400);
  for (const list of [value.personas, value.groups, value.categories]) {
    if (list.length > 100 || new Set(list.map(x => x.id)).size !== list.length || list.some(x => !/^[a-zA-Z0-9_-]{1,100}$/.test(x.id ?? '') || !name(x.name))) throw fault('INVALID_LIBRARY', 400);
    if (new Set(list.map(x => x.name.trim().toLowerCase())).size !== list.length) throw fault('DUPLICATE_NAME', 400);
  }
  if (value.personas.some(p => typeof p.text !== 'string' || !p.text.trim() || p.text.includes('\0') || Buffer.byteLength(p.text) > 60000 || p.categoryId !== null && !value.categories.some(c => c.id === p.categoryId))) throw fault('INVALID_PERSONA', 400);
  if (Object.keys(value.modes).some(m => !modes.includes(m))) throw fault('INVALID_MODE', 400);
  for (const mode of modes) {
    const m = value.modes[mode];
    if (!plain(m) || !name(m.name) || m.personaId !== null && !value.personas.some(p => p.id === m.personaId) || m.groupId !== null && !value.groups.some(g => g.id === m.groupId) || m.contextMaxTokens !== null && m.contextMaxTokens !== 0 && !integer(m.contextMaxTokens, 4000, 2000000)) throw fault('INVALID_MODE_SETTINGS', 400);
  }
  return value;
}
export function initialPreferences(seed = {}) {
  return validatePreferences({ revision: 1, policy: { ...DEFAULT_POLICY, ...seed.policy }, personas: seed.personas ?? [], groups: seed.groups ?? [], categories: seed.categories ?? [], modes: Object.fromEntries(modes.map(mode => [mode, { name: mode === 'social' ? '小鲸鱼 · 私聊' : '小鲸鱼 · 助手', personaId: seed.activePersonaId ?? null, groupId: null, contextMaxTokens: seed.contextOverride ?? null, ...seed.modes?.[mode] }])) });
}
export class Preferences {
  constructor(store, seed) {
    this.store = store;
    if (!store.db.prepare("SELECT 1 FROM settings WHERE key='preferences'").get()) store.db.prepare("INSERT INTO settings VALUES('preferences',?)").run(JSON.stringify(initialPreferences(seed)));
    this.read();
  }
  read() { const value=JSON.parse(this.store.db.prepare("SELECT value FROM settings WHERE key='preferences'").get().value);value.policy={...DEFAULT_POLICY,...value.policy};return validatePreferences(value); }
  save(value, transactional = true) {
    validatePreferences(value);
    return (transactional ? fn => this.store.transaction(fn) : fn => fn())(() => {
      const old = this.read(); if (value.revision !== old.revision) throw fault('PREFERENCES_CHANGED');
      const next = { ...value, revision: old.revision + 1 };
      // Keep previous revisions for local rollback; included in the normal SQLite backup.
      this.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('preferences-history-' + old.revision + '-' + randomUUID(), JSON.stringify(old));
      this.store.db.prepare("UPDATE settings SET value=? WHERE key='preferences'").run(JSON.stringify(next)); return next;
    });
  }
  forMode(mode) {
    const value = this.read(), settings = value.modes[mode], persona = value.personas.find(p => p.id === settings.personaId);
    return { ...value.policy, contextMaxTokens: settings.contextMaxTokens ?? value.policy.contextMaxTokens, persona: persona ? { id: persona.id, name: persona.name, text: persona.text } : null, preferencesRevision: value.revision, groupId: settings.groupId };
  }
}

export function splitReply(text, maxMessages = 2) {
  // Keep fenced code, complete lists and quoted/continuous instructions together.
  if (maxMessages === 1 || /(^|\n)\s*(?:`{3,}|~{3,}|>|[-*+]\s|\d+[.)、]\s)/.test(text)) return [text];
  const parts = text.split(/\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/).map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return [text];
  return maxMessages === 0 || parts.length <= maxMessages ? parts : [...parts.slice(0, maxMessages - 1), parts.slice(maxMessages - 1).join('\n\n')];
}
