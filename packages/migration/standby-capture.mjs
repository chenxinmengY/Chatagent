import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { inventory } from './runtime-backup.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { flag: 'wx' }); };
const inside = (root, file) => { const rel = path.relative(root, file); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
export function assertPlain(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error('STANDBY_LINK_REFUSED');
    if (current === path.dirname(current)) break;
  }
}

// 逐文件稳定性与逐库在线快照；不将其冒充生产系统的跨组件事务快照。
export async function captureStandby({ sourceRoot, dshHome, destination }) {
  if (![sourceRoot, dshHome, destination].every(p => typeof p === 'string' && path.isAbsolute(p))) throw Error('ABSOLUTE_PATH_REQUIRED');
  sourceRoot = path.resolve(sourceRoot); dshHome = path.resolve(dshHome); destination = path.resolve(destination);
  for (const p of [sourceRoot, dshHome, destination]) assertPlain(p);
  if (fs.existsSync(destination) || [sourceRoot, dshHome].some(p => p === destination || inside(p, destination) || inside(destination, p))) throw Error('STANDBY_TARGET_REFUSED');
  const evidence = [], absent = [];
  const stable = file => {
    assertPlain(file); const first = fs.readFileSync(file), second = fs.readFileSync(file);
    if (!first.equals(second)) throw Error('SOURCE_CHANGED_DURING_CAPTURE');
    return first;
  };
  const configBytes = stable(path.join(sourceRoot, 'config/wechatagent.json'));
  const config = JSON.parse(configBytes.toString().replace(/^\uFEFF/, ''));
  const account = json(path.join(sourceRoot, 'state/weflow/active-account.json')).id;
  if (!/^[a-f0-9]{64}$/.test(account) || config.wechat.whitelist.private.length !== 1) throw Error('PRIVATE_SCOPE_AMBIGUOUS');
  const key = 'wechat:private:' + config.wechat.whitelist.private[0];
  const mappingPath = path.join(sourceRoot, 'state/accounts', account, 'dsh-sessions.json');
  const mappingBytes = stable(mappingPath), mapping = JSON.parse(mappingBytes);
  const session = mapping.conversations[key], profile = mapping.profiles[key];
  if (typeof session !== 'string' || !/^[\w-]+$/.test(session) || !profile) throw Error('SOURCE_SESSION_MISSING');
  const bridgeBytes = stable(path.join(sourceRoot, 'state/bridge-config.json')), bridge = JSON.parse(bridgeBytes);
  const persona = bridge.roles?.[key]?.persona ?? bridge.role, personaName = bridge.roles?.[key]?.name ?? bridge.persona_name;
  if (typeof persona !== 'string' || !persona.trim() || persona !== profile.persona) throw Error('PERSONA_PROFILE_MISMATCH');
  const id = randomUUID(), root = destination;
  fs.mkdirSync(root, { recursive: true });
  write(path.join(root, '.standby-capture.json'), { format: 'chatagent-standby-v1', id, completed: false });
  async function copy(source, target, label) {
    assertPlain(source);
    if (!fs.existsSync(source)) { absent.push(label); return; }
    const stat = fs.lstatSync(source);
    if (stat.isDirectory()) {
      fs.mkdirSync(target, { recursive: true });
      for (const name of fs.readdirSync(source).sort()) {
        if (name.endsWith('-wal') || name.endsWith('-shm') || name.endsWith('-journal')) continue;
        await copy(path.join(source, name), path.join(target, name), label + '/' + name);
      }
    } else if (stat.isFile()) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (/\.(sqlite|db)$/.test(source) && fs.readFileSync(source).subarray(0, 16).toString() === 'SQLite format 3\0') {
        const db = new DatabaseSync(path.toNamespacedPath(source), { readOnly: true });
        try { await backup(db, path.toNamespacedPath(target)); } finally { db.close(); }
        const check = new DatabaseSync(path.toNamespacedPath(target)); try { if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error('SNAPSHOT_DATABASE_INVALID'); check.exec('PRAGMA journal_mode=DELETE'); } finally { check.close(); }
        evidence.push({ file: label, sha256: digest(fs.readFileSync(target)), boundary: 'sqlite-online-backup' });
      } else {
        const bytes = stable(source); fs.writeFileSync(target, bytes, { flag: 'wx' });
        evidence.push({ file: label, sha256: digest(bytes), boundary: 'stable-file' });
      }
    } else throw Error('SOURCE_FILE_TYPE_REFUSED');
  }
  const archive = path.join(root, 'archive'), workspace = path.join(root, 'workspace');
  for (const [rel, bytes] of [['config/wechatagent.json', configBytes], ['state/bridge-config.json', bridgeBytes], ['state/accounts/' + account + '/dsh-sessions.json', mappingBytes]]) write(path.join(archive, rel), bytes.toString());
  for (const rel of ['config/plugins.json', 'roles', 'plugins', 'state/chat-history/' + account, 'state/plugins/' + digest(account), 'state/fish-notebook/' + account, 'state/reminders/' + account, 'state/plugin-schedules/' + digest(account), 'state/member-memory/' + account]) await copy(path.join(sourceRoot, rel), path.join(archive, rel), rel);
  if (fs.readdirSync(path.join(archive, 'plugins')).sort().join(',') !== 'course-query,daily-reminders,fish-notebook,voice-awareness') throw Error('UNREVIEWED_PLUGIN_SET');
  for (const name of fs.readdirSync(path.join(sourceRoot, 'config')).filter(name => name.endsWith('.json') && !['wechatagent.json', 'plugins.json'].includes(name))) await copy(path.join(sourceRoot, 'config', name), path.join(archive, 'config', name), 'config/' + name);
  for (const rel of ['packages', 'extensions', 'state/proactive', 'state/assistant-tasks', 'state/search', 'state/desktop-companion', 'state/social-messages.json', 'state/sticker-delivery-pending.json']) await copy(path.join(sourceRoot, rel), path.join(archive, rel), rel);
  // 媒体和定制能力原件保存在档案区，不加载其生产服务配置。
  for (const rel of ['state/files', 'state/media', 'state/stickers', 'state/hearing', 'state/singing']) await copy(path.join(sourceRoot, rel), path.join(archive, rel), rel);
  for (const name of ['bili-archive', 'bili-reading', 'bili-visual', 'media-experiences', 'dsh-plugin-storage']) { const rel = 'state/accounts/' + account + '/' + name; await copy(path.join(sourceRoot, rel), path.join(archive, rel), rel); }
  for (const rel of ['fish-memory', 'fish-memory-config.json', 'attachments']) await copy(path.join(dshHome, rel), path.join(archive, 'dsh', rel), 'dsh/' + rel);
  // 原生会话全部作为只读档案，不恢复旧pending，不复用生产sessionId执行。
  await copy(path.join(dshHome, 'sessions'), path.join(archive, 'dsh/sessions'), 'dsh/sessions');
  const memoryPath = path.join(archive, 'dsh/fish-memory', session + '.json');
  if (!fs.existsSync(memoryPath)) throw Error('SCOPED_MEMORY_MISSING');
  const memory = json(memoryPath), memoryConfig = json(path.join(archive, 'dsh/fish-memory-config.json'));
  for (const rel of ['plugins', 'state/chat-history/' + account, 'state/plugins/' + digest(account), 'state/fish-notebook/' + account, 'state/reminders/' + account, 'state/plugin-schedules/' + digest(account)]) {
    const from = path.join(archive, rel); if (fs.existsSync(from)) fs.cpSync(from, path.join(workspace, rel), { recursive: true, errorOnExist: true });
  }
  write(path.join(workspace, 'package.json'), { type: 'module', private: true });
  write(path.join(workspace, 'config/wechatagent.json'), { wechat: { whitelist: { private: config.wechat.whitelist.private, groups: [] }, history: config.wechat.history } });
  write(path.join(workspace, 'config/plugins.json'), json(path.join(archive, 'config/plugins.json')));
  const hostFiles = ['packages/plugin-api/index.mjs', 'packages/plugin-api/process.mjs', 'packages/plugin-api/worker.mjs', 'packages/plugin-api/catalog.mjs', 'packages/plugin-api/documents.mjs', 'packages/plugin-api/model-utility.mjs', 'packages/extension-runtime/catalog.mjs', 'components/qq-bridge/src/safe-fetch.js', 'packages/dsh-social-bridge-plugin/deadline.mjs', 'packages/dsh-social-bridge-plugin/request-window.mjs'];
  for (const rel of hostFiles) await copy(path.join(sourceRoot, rel), path.join(workspace, rel), rel);
  const engine = path.join(dshHome, 'profiles/desktop/node_modules/dsh-fish-memory');
  // 已安装包可能由包管理器链接；解析后只复制原件，不在该目录执行代码。
  await copy(fs.realpathSync(engine), path.join(workspace, 'fish-engine'), 'fish-engine');
  const patch = (rel, from, to) => {
    const file = path.join(workspace, rel), code = fs.readFileSync(file, 'utf8');
    if (!code.includes(from) || code.indexOf(from) !== code.lastIndexOf(from)) throw Error('SOURCE_ADAPTATION_CONTRACT_CHANGED');
    fs.writeFileSync(file, code.replace(from, to));
  };
  patch('packages/plugin-api/process.mjs', "execArgv:['--max-old-space-size=96']", "execArgv:['--max-old-space-size=96','--permission','--allow-fs-read='+path.resolve(path.dirname(entry),'../..'),'--allow-fs-write='+path.resolve(path.dirname(entry),'../../state'),'--import='+new URL('./offline-guard.mjs',import.meta.url).href]");
  patch('plugins/daily-reminders/lib/store.mjs', 'new DatabaseSync(file)', 'new DatabaseSync(path.toNamespacedPath(file))');
  write(path.join(workspace, 'packages/plugin-api/offline-guard.mjs'), `import {syncBuiltinESMExports} from 'node:module';\nimport net from 'node:net'; import tls from 'node:tls'; import http from 'node:http'; import https from 'node:https'; import dns from 'node:dns';\nconst deny=()=>{throw Error('STANDBY_NETWORK_DISABLED')};\nfor(const [mod,names] of [[net,['connect','createConnection','createServer']],[tls,['connect','createServer']],[http,['request','get','createServer']],[https,['request','get','createServer']],[dns,['lookup','resolve']]]) for(const name of names) mod[name]=deny;\nnet.Socket.prototype.connect=deny; globalThis.fetch=deny; globalThis.WebSocket=class {constructor(){deny()}}; syncBuiltinESMExports();\n`);
  patch('fish-engine/lib/index.js', "const CFG_DIR = process.env.DSH_HOME || join(homedir(), '.dsh')", "const CFG_DIR = fileURLToPath(new URL('../../state/fish-home/', import.meta.url))");
  // 仅使用原召回/写入算法；不挂Web服务、升级器、定时任务或后台模型扩词。
  patch('fish-engine/lib/index.js', 'function makeRememberTool(ctx) {', 'export function makeRememberTool(ctx) {');
  patch('fish-engine/lib/index.js', 'function isEnabled(sid) {', 'export function isEnabled(sid) {');
  fs.writeFileSync(path.join(workspace, 'fish-engine/lib/hostdeps.mjs'), "export async function loadHostDeps(){return {defineTool:x=>x,createUserMessage:x=>x,notes:[],z:null};}\n");
  const engineFile = path.join(workspace, 'fish-engine/lib/index.js');
  let engineCode = fs.readFileSync(engineFile, 'utf8');
  const expansion = /((?:async )?function 自动扩词\([^]*?\)\s*\{)/;
  if (!expansion.test(engineCode)) throw Error('MEMORY_EXPANSION_CONTRACT_CHANGED');
  engineCode = engineCode.replace(expansion, '$1\n  return {disabled:true,reason:"isolated-rehearsal"};\n');
  fs.writeFileSync(engineFile, engineCode);
  write(path.join(workspace, 'state/fish-home/fish-memory', session + '.json'), fs.readFileSync(memoryPath, 'utf8'));
  // 保留原策略和称呼；读取仅通过选定的原会话别名，禁止工作区自动合库。
  write(path.join(workspace, 'state/fish-home/fish-memory-config.json'), { ...memoryConfig, 模式: 'session' });
  patch('plugins/voice-awareness/index.mjs', '已提交到微信接口', '已提交到备用端存储接口');
  const voiceFile = path.join(workspace, 'plugins/voice-awareness/index.mjs'); fs.writeFileSync(voiceFile, fs.readFileSync(voiceFile, 'utf8').replaceAll('微信语音条', '聊天语音附件'));
  const capsule = { version: 1, snapshotId: id, account, key, sourceSession: session, persona, personaName, personaDigest: digest(persona), profile, memoryDigest: digest(fs.readFileSync(memoryPath)), mode: 'rehearsal', schedulesEnabled: false };
  write(path.join(workspace, 'companion.json'), capsule);
  const pins = [];
  function pin(folder) { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) { const file = path.join(folder, entry.name); if (entry.isDirectory()) pin(file); else pins.push({ file: path.relative(workspace, file).replaceAll('\\', '/'), sha256: digest(fs.readFileSync(file)) }); } }
  for (const rel of ['packages', 'components', 'plugins', 'fish-engine']) pin(path.join(workspace, rel));
  write(path.join(workspace, 'code-integrity.json'), pins);
  const mappingAfterBytes = stable(mappingPath), mappingAfter = JSON.parse(mappingAfterBytes);
  const bridgeAfter = JSON.parse(stable(path.join(sourceRoot, 'state/bridge-config.json')));
  const accountAfter = json(path.join(sourceRoot, 'state/weflow/active-account.json')).id;
  if (accountAfter !== account || mappingAfter.conversations[key] !== session || mappingAfter.profiles[key]?.persona !== persona || (bridgeAfter.roles?.[key]?.persona ?? bridgeAfter.role) !== persona) throw Error('SOURCE_IDENTITY_CHANGED_DURING_CAPTURE');
  const history = new DatabaseSync(path.join(workspace, 'state/chat-history', account, 'history.sqlite'), { readOnly: true });
  let historyCount; try { historyCount = history.prepare('SELECT count(*) n FROM records WHERE chat=?').get(key).n; } finally { history.close(); }
  const report = { format: 'chatagent-standby-v1', id, completed: true, capturedAt: new Date().toISOString(), consistency: 'per-file-and-per-database; cross-component-not-proven', sourceSessionMetadataChanged: !mappingAfterBytes.equals(mappingBytes), personaSha256: digest(persona), memories: memory.memories.length, deletedMemories: memory.deleted.length, historyRecords: historyCount, pluginIds: fs.readdirSync(path.join(workspace, 'plugins')), files: evidence.length, absent, scheduling: 'paused', externalModelCalls: 0 };
  write(path.join(root, 'inventory.private.json'), evidence);
  fs.writeFileSync(path.join(root, '.standby-capture.json'), JSON.stringify(report, null, 2));
  sealStandbyCapture(root);
  return { root, workspace, report };
}

export function sealStandbyCapture(root) {
  assertPlain(root);
  const report = json(path.join(root, '.standby-capture.json'));
  if (report.format !== 'chatagent-standby-v1' || !report.completed) throw Error('STANDBY_CAPTURE_INCOMPLETE');
  const files = ['archive', 'workspace'].flatMap(name => inventory(path.join(root, name), name + '/'));
  write(path.join(root, 'contents.private.json'), { snapshotId: report.id, files });
}

export function verifyStandbyCapture(root) {
  assertPlain(root);
  const report = json(path.join(root, '.standby-capture.json')), manifest = json(path.join(root, 'contents.private.json'));
  if (!report.completed || manifest.snapshotId !== report.id) throw Error('STANDBY_CAPTURE_INCOMPLETE');
  const files = ['archive', 'workspace'].flatMap(name => inventory(path.join(root, name), name + '/'));
  if (JSON.stringify(files) !== JSON.stringify(manifest.files)) throw Error('STANDBY_CAPTURE_DAMAGED');
  return { snapshotId: report.id, files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}
