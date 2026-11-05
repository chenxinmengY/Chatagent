import crypto from 'node:crypto';
export function voiceContext(rows, now = Date.now()) {
  const recent = rows.filter(row => Number(row.timestamp) * 1000 >= now - 10 * 60_000)
    .filter(row => String(row.text || '').trim()).slice(-8);
  const lastIncoming = recent.findLast(row => !row.outgoing);
  if (!lastIncoming) return null;
  return {
    turn: String(lastIncoming.id || lastIncoming.delivery_id || lastIncoming.timestamp) + ':' +
      crypto.createHash('sha256').update(String(lastIncoming.text)).digest('hex').slice(0, 16),
    messages: recent.map(row => ({ role: row.outgoing ? 'assistant' : 'user', text: String(row.text).slice(0, 500) }))
  };
}

export function parseVoiceIntent(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const result = JSON.parse(cleaned);
  if (typeof result.speak !== 'boolean') throw new Error('Invalid voice intent');
  return { speak: result.speak, reason: result.speak ? 'context_request' : 'context_no_request' };
}

export function createVoiceIntentJudge(infer = async () => { throw Error('VOICE_INTENT_MODEL_NOT_CONNECTED'); }) {
  const cache = new Map();
  return async (key, context, settings = {}) => {
    if (!context) return { speak: false, reason: 'no_recent_context' };
    const id = key + ':' + context.turn;
    if (!cache.has(id)) {
      cache.set(id, Promise.resolve().then(() => infer(context, settings))
        .catch(error => ({ speak: false, reason: 'intent_unavailable',
          ...(error.intentDetail ? { detail: error.intentDetail } : {}) })));
      if (cache.size > 256) cache.delete(cache.keys().next().value);
    }
    return cache.get(id);
  };
}
