// No transcript deletion: the native compactor changes the model surface only.
export async function maintainMode({ policy, measurement, signature, previous, now, compact }) {
  if (!policy.enabled || policy.maxTokens === 0) return { ...previous, state: 'disabled' };
  if (!measurement || !Number.isSafeInteger(measurement.totalTokens)) return { ...previous, state: 'unavailable' };
  if (measurement.totalTokens < policy.maxTokens) return { ...previous, state: 'below_threshold', tokens: measurement.totalTokens };
  if (previous?.signature === signature && (previous.completed || previous.attempts >= 3 || previous.retryAt > now)) return { ...previous, state: previous.completed ? 'waiting_new_messages' : 'waiting_retry' };
  const next = { signature, attempts: previous?.signature === signature ? previous.attempts + 1 : 1, retryAt: now + 300000, completed: false, tokensBefore: measurement.totalTokens };
  try { const result = await compact(); return { ...next, completed: true, state: result === null ? 'no_useful_range' : 'compacted', at: now }; }
  catch { return { ...next, state: 'waiting_retry' }; }
}
