import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ReminderStore} from './lib/store.mjs';
import {beijing} from './lib/time.mjs';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const stores = new Map();
function storeFor(ctx) {
  if (!stores.has(ctx.account.id)) stores.set(ctx.account.id, new ReminderStore(root, ctx.account.id));
  return stores.get(ctx.account.id);
}
function hostReady(ctx) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(root, 'state/reminders/host-status.json'), 'utf8'));
    return state.online === true && state.account === ctx.account.id && ctx.now - state.at >= -5000 && ctx.now - state.at < 20000;
  } catch {return false;}
}
const instructions = '事项提醒必须调用 daily-reminders__manage 并在保存成功后才承诺设好。只有用户明确委托才设置。时间不全先问；所有相对日期按本轮北京时间计算。一次性用repeat=once、date和time；重复用daily或weekly，周一=1至周日=7；未指定起止时不传。每天/每周默认从下一次开始，直到取消。查看或删除旧重复提醒：list,kind=repeating，按稳定R编号cancel；多条不明确先询问。修改重复时间必须明确scope=occurrence或series；“以后”改series，“这次”改occurrence。snooze仅延后这一轮；skip跳过这一轮。全量取消仅用户明确要求时all=true，kind可限定repeating。不要将发送成功说成用户已完成事项；不重复催促。工具的needs_clarification或error请解释，不伪造成功。措辞phrase可用你自然的说话方式，保留事项事实，不添加其他要求。';

export function setup(api) {
  api.registerTool({id: 'manage', description: '管理用户明确委托的事项提醒：创建一次性/每天/每周提醒，查看、修改、取消、跳过这次、稍后再提醒。必须实际保存成功才能说已设置。未给几点必须询问；重复修改范围不明必须询问。编号R01等来自列表，不猜编号。',
    parameters: {type: 'object', properties: {
      action: {type: 'string', enum: ['create', 'list', 'update', 'cancel', 'skip', 'snooze']},
      text: {type: 'string', maxLength: 300, description: '提醒事项的准确内容'},
      phrase: {type: 'string', maxLength: 600, description: '可选：到点说的自然措辞，必须保留事项事实'},
      repeat: {type: 'string', enum: ['once', 'daily', 'weekly']},
      date: {type: 'string', maxLength: 24, description: '一次性日期：today、tomorrow、day-after-tomorrow 或 YYYY-MM-DD'},
      time: {type: 'string', maxLength: 5, description: '北京时间24小时制HH:MM，未明确几点时先问'},
      weekdays: {type: 'array', items: {type: 'integer', minimum: 1, maximum: 7}, maxLength: 7, description: 'weekly必需：1=周一，7=周日'},
      startDate: {type: 'string', maxLength: 24}, endDate: {type: 'string', maxLength: 24},
      planId: {type: 'string', maxLength: 24, description: '已有计划的稳定编号，如R03'},
      query: {type: 'string', maxLength: 100, description: '按事项名称匹配，多条相似时返回待澄清'},
      kind: {type: 'string', enum: ['all', 'once', 'repeating'], description: '查看或全量取消的范围'},
      scope: {type: 'string', enum: ['occurrence', 'series'], description: '修改重复提醒必需：仅这次或以后所有轮次'},
      all: {type: 'boolean', description: '仅在用户明确要求取消所有指定范围提醒时为true'},
      delayMinutes: {type: 'integer', minimum: 1, maximum: 525600, description: '几分钟后的一次性提醒或snooze；不与date/time同时传'},
      occurrenceId: {type: 'string', maxLength: 64, description: '可选：工具返回的具体轮次id'},
      offset: {type: 'integer', minimum: 0, description: 'list分页：需要更多时传上次返回的nextOffset'},
      includeInactive: {type: 'boolean', description: '查看已取消或完成的计划'}
    }, required: ['action'], additionalProperties: false},
    async execute(ctx, args) {
      if (ctx.chat.kind !== 'private') return {content: '事项提醒仅支持授权私聊', isError: true};
      if (['create', 'update', 'snooze'].includes(args.action) && !hostReady(ctx)) return {content: '提醒服务尚未加载或已离线，未设置成功；请先恢复微信后台服务。', isError: true};
      try {
        const result = storeFor(ctx).manage(ctx.chat.key, args, ctx.now);
        // Keep tool output valid JSON under the host's 12,000 character cap.
        while (JSON.stringify(result).length > 10000 && result.recent?.length) result.recent.pop();
        while (JSON.stringify(result).length > 10000 && result.plans?.length > 1) {
          result.plans.pop();
          if (args.action === 'list') result.nextOffset = (args.offset ?? 0) + result.plans.length;
        }
        return {content: JSON.stringify({now: beijing(ctx.now), ...result})};
      } catch (error) {
        if (error.code || error.message?.includes('database')) return {content: JSON.stringify({status: 'error', message: '提醒保存或读取失败，原数据已保留；未确认设置成功。'}), isError: true};
        return {content: JSON.stringify({status: 'needs_clarification', message: error.message}), isError: false};
      }
    }
  });
}
export const hooks = {'before-context': async ctx => ({context: `当前北京时间：${beijing(ctx.now).replace('T', ' ')}。${instructions}`})};
