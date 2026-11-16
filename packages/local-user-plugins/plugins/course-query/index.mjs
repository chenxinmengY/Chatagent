import fs from 'node:fs';
import {clock, queryTimetable} from './lib/query.mjs';

const data = JSON.parse(fs.readFileSync(new URL('./assets/timetable.json', import.meta.url), 'utf8'));
if (data.schemaVersion !== 1 || data.timezone !== 'Asia/Shanghai' || !data.courses?.length || !data.coveredDates?.length) throw Error('课表数据无效，请重新导入。');
const key = 'last_query';
const instructions = '仅在用户询问课程、教室、任课教师或追问课表时调用 course-query__query。下一节用 action=next；今天/明天全天用 day,date=today/tomorrow,period=all；下午用 period=afternoon；“还有”加 remaining=true。教室或教师追问用 details，明确的课程 id 优先，否则沿用最近结果；多门不明确时先澄清。当前时间只取宿主，不猜现在几点，不自行推断调课，不主动提醒。';

async function previousFor(ctx) {
  const previous = await ctx.storage.get(key);
  return previous?.sessionId === ctx.sessionId ? previous : null;
}

export function setup(api) {
  api.registerTool({
    id: 'query',
    description: '查用户个人课表的唯一事实来源。用户问下一节/今天/明天/下午的课、教室、任课教师或追问那节课时使用。next 按真实北京时间查下一门并附当前课；day 查日期全部课程；details 查最近结果中的某门。禁止凭记忆猜课程或时间。',
    parameters: {type: 'object', properties: {
      action: {type: 'string', enum: ['next', 'day', 'details']},
      date: {type: 'string', maxLength: 24, description: 'day 的日期，省略为今天：today、tomorrow、day-after-tomorrow 或 YYYY-MM-DD；details 可按日期查；next 不传。'},
      period: {type: 'string', enum: ['all', 'morning', 'afternoon', 'evening'], description: 'day 的时段，默认全天；next 不传。'},
      remaining: {type: 'boolean', description: 'day：用户问还有什么课时为 true；默认 false，完整列出该时段。'},
      courseId: {type: 'string', maxLength: 40, description: 'details：先前查询返回的课程 id。'},
      name: {type: 'string', minLength: 1, maxLength: 120, description: 'details：课程名称，可结合 date。'},
      ordinal: {type: 'integer', minimum: 1, maximum: 40, description: 'details：最近返回列表的第几门，从 1 开始。'},
      reference: {type: 'string', enum: ['last', 'current'], description: 'details：默认指最近查询的课程；current 指最近 next 结果中正在上的课。'}
    }, required: ['action'], additionalProperties: false},
    async execute(ctx, args) {
      const result = queryTimetable(data, args, ctx.now, await previousFor(ctx));
      if (args.action !== 'details' || result.status === 'ok') {
        await ctx.storage.set(key, {sessionId: ctx.sessionId, revision: data.revision,
          ids: result.referenceIds, currentIds: result.referenceCurrentIds, queriedAt: ctx.now});
      }
      return {content: JSON.stringify(result)};
    }
  });
}

export const hooks = {
  'before-context': async ctx => {
    const now = clock(ctx.now), previous = await previousFor(ctx);
    const ids = previous?.revision === data.revision ? [...new Set([...(previous.ids ?? []), ...(previous.currentIds ?? [])])] : [];
    const references = ids.map(id => data.courses.find(c => c.id === id)).filter(Boolean)
      .map(c => ({id: c.id, date: c.date, name: c.name, start: c.start}));
    return {context: `北京时间：${now.date} ${now.weekday} ${now.time}。${instructions}\n最近课表查询中的课程引用（具体教室和教师请调用工具核实）：${JSON.stringify(references)}`};
  }
};
