const STALE_AFTER_MS = 30 * 60 * 1000;

// 确认只在本次档案代号与30分钟窗口内有效，不能把一次确认当作永久执行授权。
export function outboxAction(item, epoch, now = Date.now(), currentMode) {
  if (currentMode && (!['social', 'assistant'].includes(item.expectedMode) ||
      !Number.isSafeInteger(item.expectedModeRevision) || item.expectedMode !== currentMode.mode ||
      item.expectedModeRevision !== currentMode.modeRevision)) return 'hold_mode';
  if (item.hold || !Number.isSafeInteger(item.queuedAt) || !Number.isSafeInteger(now) || now < item.queuedAt ||
      (item.epoch && item.epoch !== epoch)) return 'hold';
  if (item.confirmedAt !== undefined) {
    if (!Number.isSafeInteger(item.confirmedAt) || item.confirmedAt < item.queuedAt || item.confirmedAt > now ||
        now - item.confirmedAt > STALE_AFTER_MS) return 'hold';
    return 'submit_and_confirm';
  }
  return now - item.queuedAt > STALE_AFTER_MS ? 'hold' : 'submit';
}
