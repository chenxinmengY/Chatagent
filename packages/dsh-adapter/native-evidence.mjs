import { createHash } from 'node:crypto';

const hash = text => createHash('sha256').update(text).digest('hex');
const FORMAT = 'chatagent-isolated-dsh-v1';

export function admittedMessages(events, requestId) {
  return events.flatMap(event => event.type === 'user/message' ? [event.data] : event.type === 'agent/inbox/spliced' ? event.data.inserted : [])
    .filter(message => message.source?.kind === FORMAT && message.source.requestId === requestId);
}

export function assertRequestIdentity(messages, request) {
  for (const message of messages) if (message.source.mode !== request.mode || hash(message.content.filter(part => part.type === 'text').map(part => part.text).join('')) !== request.text_hash) throw Error('DSH_LOG_REQUEST_CONFLICT');
}

// 在运行时和恢复预检中使用同一完成证据规则；此函数没有执行模型或启动任务的能力。
export function completedReply(events, request) {
  assertRequestIdentity(admittedMessages(events, request.id), request);
  const accepted = events.find(event => event.type === 'user/message' && event.data.source?.kind === FORMAT && event.data.source.requestId === request.id);
  if (!accepted) return null;
  const turn = events.findLast(event => event.type === 'turn/start' && event.seq < accepted.seq)?.data.turn;
  const end = events.find(event => event.type === 'turn/end' && event.data.turn === turn && event.seq > accepted.seq);
  if (!end || end.data.reason?.kind !== 'completed') return null;
  const message = events.findLast(event => event.type === 'assistant/message' && event.data.turn === turn && event.seq > accepted.seq && event.seq < end.seq)?.data.message;
  if (!message || message.toolCalls?.length || message.content.some(part => ['tool-call', 'tool_call', 'tool_use'].includes(part.type))) return null;
  const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('');
  return text.trim() ? text : null;
}
