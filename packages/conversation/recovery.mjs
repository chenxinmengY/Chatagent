export const STALE_AFTER_MS = 30 * 60 * 1000;

// 纯决策函数；服务端入队和开始处理时在 ChatStore 事务内再次检查。
export function recoveryAction({ state, queuedAt, confirmedAt, now, thresholdMs = STALE_AFTER_MS, epochChanged = false }) {
  if (state === 'completed') return 'sync_existing_reply';
  if (state === 'running') return 'observe_existing_run';
  if (state === 'unknown') return 'reconcile';
  if (state === 'cancelled' || state === 'failed') return 'show_terminal_state';
  if (!['not_received', 'queued'].includes(state)) throw new Error('INVALID_MESSAGE_STATE');
  if (epochChanged || !Number.isSafeInteger(now) || !Number.isSafeInteger(queuedAt) || now < queuedAt) return 'reconcile';
  if (!Number.isSafeInteger(thresholdMs) || thresholdMs < 0) throw new Error('INVALID_STALE_THRESHOLD');
  // confirmedAt 必须是服务端已保存的用户确认时间，不能直接信任客户端声称。
  if (confirmedAt !== undefined && (!Number.isSafeInteger(confirmedAt) || confirmedAt < queuedAt || confirmedAt > now)) return 'reconcile';
  return now - (confirmedAt ?? queuedAt) > thresholdMs ? 'require_confirmation' : 'resume_same_id';
}
