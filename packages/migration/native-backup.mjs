import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { admittedMessages, assertRequestIdentity, completedReply } from '../dsh-adapter/native-evidence.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const fail = code => { throw Error(code); };

// 仅检查本项目生成的无压缩、未seed的v4日志。未知格式必须显式升级适配，不能静默当作可恢复。
export function verifyNativeBackup(root, identity, bindings, requests, files) {
  const expected = new Map(['social', 'assistant'].map(mode => ['chatagent-' + mode + '-' + hash(identity).slice(0, 32), mode]));
  const sessions = new Map(), admissions = new Map();
  for (const file of files.filter(item => /\.jsonl(?:\..*)?$/.test(item.path))) {
    if (path.basename(file.path) !== 'session.v4.jsonl') fail('BACKUP_DSH_FORMAT_UNSUPPORTED');
    const raw = fs.readFileSync(path.join(root, ...file.path.split('/')), 'utf8');
    if (!raw.endsWith('\n')) fail('BACKUP_DSH_LOG_INVALID');
    let rows;
    try { rows = raw.slice(0, -1).split('\n').map(line => JSON.parse(line)); } catch { fail('BACKUP_DSH_LOG_INVALID'); }
    const [header, ...events] = rows;
    if (header?.version !== 4) fail('BACKUP_DSH_FORMAT_UNSUPPORTED');
    if (header.type !== 'session' || !expected.has(header.id) || path.basename(path.dirname(file.path)) !== header.id || sessions.has(header.id)) fail('BACKUP_DSH_SESSION_IDENTITY_INVALID');
    if (header.isSeeded !== false || !Number.isSafeInteger(header.createdAt) || header.createdAt < 0) fail('BACKUP_DSH_LOG_INVALID');
    if (events.some((event, index) => !event || event.seq !== index || !Number.isSafeInteger(event.time) || event.time < 0 || typeof event.type !== 'string' || !event.data || typeof event.data !== 'object' || Array.isArray(event.data))) fail('BACKUP_DSH_LOG_INVALID');
    sessions.set(header.id, events);
    try {
      for (const event of events) {
        const messages = event.type === 'user/message' ? [event.data] : event.type === 'agent/inbox/spliced' ? event.data.inserted : [];
        if (!Array.isArray(messages)) fail('BACKUP_DSH_LOG_INVALID');
        for (const message of messages) {
          if (message?.source?.kind !== 'chatagent-isolated-dsh-v1') continue;
          const { requestId, mode } = message.source;
          if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId) || mode !== expected.get(header.id) || !Array.isArray(message.content)) fail('BACKUP_DSH_REQUEST_CONFLICT');
          const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('');
          const signature = mode + ':' + hash(text), previous = admissions.get(requestId);
          if (previous && previous !== signature) fail('BACKUP_DSH_REQUEST_CONFLICT');
          admissions.set(requestId, signature);
        }
      }
    } catch (error) { if (error.message.startsWith('BACKUP_')) throw error; fail('BACKUP_DSH_LOG_INVALID'); }
  }
  for (const binding of bindings) if (!sessions.has(binding.session_id)) fail('BACKUP_DSH_SESSION_MISSING');
  for (const request of requests) {
    const events = sessions.get(request.session_id);
    if (!events) fail('BACKUP_DSH_SESSION_MISSING');
    try {
      const signature = admissions.get(request.id);
      if (signature && signature !== request.mode + ':' + request.text_hash) fail('BACKUP_DSH_REQUEST_CONFLICT');
      assertRequestIdentity(admittedMessages(events, request.id), request);
      if (request.state === 'completed' && completedReply(events, request) !== request.reply) fail('BACKUP_DSH_REPLY_UNPROVEN');
    } catch (error) { if (error.message.startsWith('BACKUP_')) throw error; fail('BACKUP_DSH_REQUEST_CONFLICT'); }
  }
}
