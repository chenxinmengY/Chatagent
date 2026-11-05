function dateKeys(time) {
  if (!Number.isSafeInteger(time) || time < 0) throw new Error('INVALID_SNAPSHOT_TIME');
  // 用户约定时区 Asia/Shanghai，当前备份日期使用 UTC+8。
  const date = new Date(time + 8 * 3600000);
  const day = date.toISOString().slice(0, 10);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return { day, week: date.toISOString().slice(0, 10) };
}

// 只生成保留/候选清单；没有删除文件的能力。
export function retentionPlan(snapshots) {
  const ids = new Set();
  for (const item of snapshots) {
    if (!item.id || ids.has(item.id) || !['automatic', 'manual'].includes(item.kind) ||
      !['complete', 'partial', 'inconsistent', 'failed'].includes(item.status)) throw new Error('INVALID_RETENTION_ITEM');
    ids.add(item.id); dateKeys(item.createdAt);
  }
  const sorted = [...snapshots].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const complete = sorted.filter(x => x.status === 'complete' && x.published === true);
  const selected = new Map();
  const keep = (item, reason) => selected.set(item.id, [...(selected.get(item.id) ?? []), reason]);
  for (const item of sorted) {
    if (item.pinned) keep(item, 'important');
    if (item.kind === 'manual') keep(item, 'manual');
    if (!complete.includes(item)) keep(item, 'review_incomplete');
  }
  const days = new Set(), weeks = new Set();
  for (const item of complete.filter(x => x.kind === 'automatic')) {
    const { day, week } = dateKeys(item.createdAt);
    if (days.size < 7 && !days.has(day)) { days.add(day); keep(item, 'daily'); }
    if (weeks.size < 4 && !weeks.has(week)) { weeks.add(week); keep(item, 'weekly'); }
  }
  const restored = complete.find(x => x.restoreVerified === true);
  if (restored) keep(restored, 'last_verified_restore');
  return { keep: [...selected].map(([id, reasons]) => ({ id, reasons })),
    removalCandidates: complete.filter(x => !selected.has(x.id)).map(x => x.id) };
}
