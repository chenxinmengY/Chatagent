export const MINUTE = 60000, DAY = 86400000, GRACE = 20 * MINUTE;
export function beijing(now) {
  if (!Number.isSafeInteger(now)) throw Error('宿主时间无效');
  return new Date(now + 8 * 3600000).toISOString().slice(0, 16);
}
export function dateValue(value, now) {
  const today = beijing(now).slice(0, 10);
  const relative = {today: 0, tomorrow: 1, 'day-after-tomorrow': 2};
  if (Object.hasOwn(relative, value)) return new Date(Date.parse(today + 'T00:00Z') + relative[value] * DAY).toISOString().slice(0, 10);
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Error('请明确日期');
  const parsed = Date.parse(value + 'T00:00Z');
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) throw Error('日期不存在');
  return value;
}
export function epoch(date, time) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time ?? '')) throw Error('请明确几点提醒（HH:MM）');
  return Date.parse(`${date}T${time}:00+08:00`);
}
export function nextDue(schedule, after) {
  if (schedule.kind === 'once') return schedule.at >= after ? schedule.at : null;
  let date = beijing(after).slice(0, 10);
  if (schedule.start && date < schedule.start) date = schedule.start;
  for (let i = 0; i < 8; i++) {
    if (schedule.end && date > schedule.end) return null;
    const weekday = new Date(date + 'T00:00Z').getUTCDay() || 7;
    const due = epoch(date, schedule.time);
    if (due >= after && (schedule.kind === 'daily' || schedule.weekdays.includes(weekday))) return due;
    date = new Date(Date.parse(date + 'T00:00Z') + DAY).toISOString().slice(0, 10);
  }
  return null;
}
export function scheduleFrom(args, now, previous = null) {
  const kind = args.repeat ?? previous?.kind ?? 'once';
  if (!['once', 'daily', 'weekly'].includes(kind)) throw Error('仅支持一次性、每天和每周指定星期');
  if (args.delayMinutes !== undefined) {
    if (kind !== 'once' || !Number.isInteger(args.delayMinutes) || args.delayMinutes < 1 || args.delayMinutes > 525600 || args.date || args.time) throw Error('延后分钟数无效或与日期时间冲突');
    return {kind, at: now + args.delayMinutes * MINUTE};
  }
  if (kind === 'once') {
    const date = args.date ? dateValue(args.date, now) : previous?.at ? beijing(previous.at).slice(0, 10) : null;
    const time = args.time ?? (previous?.at ? beijing(previous.at).slice(11) : null);
    if (!date) throw Error('一次性提醒需要明确日期');
    const at = epoch(date, time);
    if (at <= now) throw Error('指定时间已经过去，请确认新的提醒时间');
    return {kind, at};
  }
  if (args.date) throw Error('重复提醒的开始日期请用 startDate');
  const time = args.time ?? previous?.time;
  epoch(beijing(now).slice(0, 10), time);
  const weekdays = args.weekdays ?? previous?.weekdays ?? [];
  if (kind === 'weekly' && (!Array.isArray(weekdays) || !weekdays.length || weekdays.some(x => !Number.isInteger(x) || x < 1 || x > 7))) throw Error('每周提醒需要星期，1=周一，7=周日');
  const start = args.startDate ? dateValue(args.startDate, now) : previous?.start ?? beijing(now).slice(0, 10);
  const end = args.endDate ? dateValue(args.endDate, now) : previous?.end ?? null;
  if (end && end < start) throw Error('结束日期不能早于开始日期');
  const result = {kind, time, weekdays: kind === 'weekly' ? [...new Set(weekdays)].sort() : [], start, end};
  if (nextDue(result, now + 1) === null) throw Error('该时间范围没有后续提醒');
  return result;
}
