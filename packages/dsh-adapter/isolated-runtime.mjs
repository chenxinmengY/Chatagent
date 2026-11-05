import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { copyTree, plainDirectory, sealDatabase } from '../migration/runtime-backup.mjs';
import { admittedMessages, completedReply } from './native-evidence.mjs';
import { ownerRecord, ownerDefinitelyGone } from '../storage/process-owner.mjs';
import { maintainMode } from './context-maintenance.mjs';
import { createAudioInput } from './audio-input.mjs';

const APPLICATION_ID = 0x43414453;
const FORMAT = 'chatagent-isolated-dsh-v1';
const hash = text => createHash('sha256').update(text).digest('hex');
const fail = code => new Error(code);

function rejectLinks(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (fs.lstatSync(file).isSymbolicLink()) throw fail('DSH_DATA_LINK_REFUSED');
    if (entry.isDirectory()) rejectLinks(file);
  }
}
function prepareRoot(dataRoot) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) throw fail('ABSOLUTE_DSH_DATA_ROOT_REQUIRED');
  const root = path.resolve(dataRoot);
  let ancestor = root;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (fs.realpathSync(ancestor).toLowerCase() !== ancestor.toLowerCase()) throw fail('DSH_DATA_LINK_REFUSED');
  fs.mkdirSync(root, { recursive: true });
  rejectLinks(root);
  const marker = path.join(root, '.chatagent-dsh.json');
  if (!fs.existsSync(marker)) {
    if (fs.readdirSync(root).length) throw fail('FOREIGN_DSH_DATA_ROOT_REFUSED');
    fs.writeFileSync(marker, JSON.stringify({ format: FORMAT, id: randomUUID() }), { flag: 'wx' });
  }
  const identity = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (identity.format !== FORMAT || !/^[a-f0-9-]{36}$/.test(identity.id ?? '')) throw fail('FOREIGN_DSH_DATA_ROOT_REFUSED');
  return root;
}
function lockRoot(root) {
  const guard = path.join(root, 'lock-guard'), file = path.join(root, 'runtime.lock'), token = randomUUID();
  try { fs.mkdirSync(guard); } catch { throw fail('DSH_LOCK_CHECK_IN_PROGRESS'); }
  try {
    if (fs.existsSync(file)) {
      const old = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Number.isSafeInteger(old.pid) || old.pid < 1) throw fail('INVALID_DSH_RUNTIME_LOCK');
      if (!ownerDefinitelyGone(old, file)) throw fail('DSH_RUNTIME_ALREADY_RUNNING');
      fs.renameSync(file, path.join(root, 'stale-lock-' + randomUUID() + '.json'));
    }
    fs.writeFileSync(file, JSON.stringify(ownerRecord(token)), { flag: 'wx' });
  } finally { fs.rmdirSync(guard); }
  return () => { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === token) fs.unlinkSync(file); };
}

function assertSettled(events) {
  const start = events.findLast(event => event.type === 'turn/start');
  if (start && !events.some(event => event.type === 'turn/end' && event.data.turn === start.data.turn && event.seq > start.seq)) throw fail('DSH_SESSION_REQUIRES_RECONCILIATION');
  const inbox = { 'next-turn': [], 'next-step': [] };
  for (const event of events) if (event.type === 'agent/inbox/spliced') {
    const data = event.data;
    if (!inbox[data.target]) throw fail('DSH_INBOX_UNRECOGNIZED');
    inbox[data.target].splice(data.start, data.removedCount ?? 0, ...data.inserted);
  }
  if (Object.values(inbox).some(list => list.length)) throw fail('DSH_SESSION_REQUIRES_RECONCILIATION');
}

// 只组合显式SDK服务与调用方注入的适配器；不会读取安装配置、凭据、生产preset或工具插件。
export async function createIsolatedDshRuntime({ sdkRoot, dataRoot, adapterFactory, companionFactory, modelRouter, speechRecognizer, provider = 'chatagent-synthetic', model = 'synthetic-text', turnTimeoutMs = 30000, allowCompaction = false } = {}) {
  if (!sdkRoot || !path.isAbsolute(sdkRoot) || typeof adapterFactory !== 'function' || !Number.isSafeInteger(turnTimeoutMs) || turnTimeoutMs < 100 || turnTimeoutMs > 120000) throw fail('INVALID_ISOLATED_DSH_OPTIONS');
  const root = prepareRoot(dataRoot), release = lockRoot(root);
  const ledgerFile = path.join(root, 'requests.sqlite');
  let ledger, ctx, companion;
  const handles = new Map(), turnModels = new Map();
  let queue = Promise.resolve(), closing = false, closeJob;
  const load = name => import(pathToFileURL(path.join(sdkRoot, name, 'lib/index.js')).href);
  try {
    if (fs.existsSync(ledgerFile)) {
      const probe = new DatabaseSync(ledgerFile, { readOnly: true });
      try { if (probe.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID) throw fail('FOREIGN_DSH_LEDGER_REFUSED'); }
      finally { probe.close(); }
    }
    ledger = new DatabaseSync(ledgerFile);
    ledger.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS modes(mode TEXT PRIMARY KEY,session_id TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,mode TEXT NOT NULL,text_hash TEXT NOT NULL,state TEXT NOT NULL,reply TEXT,session_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_attempts(mode TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS request_models(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      UPDATE requests SET state='unknown' WHERE state='running';`);
    const audioInput = speechRecognizer ? createAudioInput({ db: ledger, root, recognize: speechRecognizer }) : null;
    const [cordis, sessions, agents, llm, prompt, tools, projections, persistence, loop, persistenceApi] = await Promise.all([
      load('cordis'), load('dsh-session'), load('dsh-agent'), load('dsh-llm'), load('dsh-system-prompt'), load('dsh-tools'), load('dsh-session-projection'), load('dsh-session-persistence-jsonl'), load('dsh-agent-loop'), load('dsh-session-persistence')
    ]);
    ctx = new cordis.Context();
    for (const [plugin, config] of [[sessions.default, {}], [agents.default, {}], [llm.default, {}], [prompt.default, { includeRuntimeContext: false }], [tools.default, { mode: 'native' }], [projections.default, {}]]) await ctx.plugin(plugin, config);
    await ctx.plugin((await load('dsh-token-meter')).default, {});
    if (allowCompaction) await ctx.plugin((await load('dsh-compaction-basic')).default, { auto: false, compactionRetries: 0 });
    const sessionsRoot = path.join(root, 'sessions'); fs.mkdirSync(sessionsRoot, { recursive: true });
    await ctx.plugin(persistence, { root: sessionsRoot, compression: 'none', listConcurrency: 1 });
    await ctx.plugin({ name: 'chatagent-injected-provider', inject: ['llm'], async apply(pluginCtx) {
      const adapter = await adapterFactory({ LlmAdapter: llm.LlmAdapter, provider, model });
      pluginCtx.llm.registerAdapter([provider], adapter);
    } });
    await ctx.plugin(loop.default, { agents: [], maxParallelToolCalls: 1 });
    if (!ctx.get('agentLoop')) throw fail('DSH_AGENT_LOOP_NOT_READY');
    const identity = JSON.parse(fs.readFileSync(path.join(root, '.chatagent-dsh.json'), 'utf8')).id;
    const sessionIdFor = mode => 'chatagent-' + mode + '-' + hash(identity).slice(0, 32);
    if (companionFactory) companion = await companionFactory({ root });

    async function eventsFor(sessionId) {
      const live = ctx.get('agents').get(sessionId);
      if (live) { await ctx.get('sessions').flush(live.session); return live.session.snapshotEvents(); }
      const handle = await ctx.get('sessionPersistence').open(sessionId, 'read');
      try { return (await handle.read()).events; } finally { await handle.close(); }
    }
    async function reconcile(request) {
      let text;
      try { text = completedReply(await eventsFor(request.session_id), request); } catch { return null; }
      if (text === null) return null;
      ledger.prepare("UPDATE requests SET state='completed',reply=? WHERE id=?").run(text, request.id); return text;
    }
    async function execute(request) {
      const textHash = hash(request.text), existing = ledger.prepare('SELECT * FROM requests WHERE id=?').get(request.id);
      if (existing) {
        if (existing.mode !== request.mode || existing.text_hash !== textHash) throw fail('DSH_REQUEST_ID_REUSED');
        if (existing.state === 'completed') { companion?.record(request, existing.reply); return existing.reply; }
        const recovered = await reconcile(existing);
        if (recovered !== null) { companion?.record(request, recovered); return recovered; }
        throw fail('DSH_RESULT_UNKNOWN');
      }
      if (ledger.prepare("SELECT 1 FROM requests WHERE mode=? AND state!='completed' LIMIT 1").get(request.mode)) throw fail('DSH_MODE_REQUIRES_RECONCILIATION');
      let binding = ledger.prepare('SELECT * FROM modes WHERE mode=?').get(request.mode);
      const wasBound = !!binding;
      if (!binding) {
        binding = { mode: request.mode, session_id: sessionIdFor(request.mode) };
        ledger.prepare('INSERT INTO modes VALUES(?,?)').run(binding.mode, binding.session_id);
      }
      const recorded = { ...request, text_hash: textHash, session_id: binding.session_id };
      ledger.prepare("INSERT INTO requests(id,mode,text_hash,state,session_id) VALUES(?,?,?,'running',?)").run(request.id, request.mode, textHash, binding.session_id);
      let agent, timer;
      try {
        let nativeEvents, fresh = false;
        try { nativeEvents = await eventsFor(binding.session_id); }
        catch (error) {
          if (!wasBound && error instanceof persistenceApi.SessionPersistenceNotFoundError) { nativeEvents = []; fresh = true; }
          else throw error;
        }
        // 账本可能来自较旧备份。原生日志证明已接纳的请求不可再次 followup。
        for (const otherMode of ['social', 'assistant'].filter(mode => mode !== request.mode)) {
          const other = ledger.prepare('SELECT session_id FROM modes WHERE mode=?').get(otherMode);
          let otherEvents;
          try { otherEvents = await eventsFor(other?.session_id ?? sessionIdFor(otherMode)); }
          catch (error) { if (!other && error instanceof persistenceApi.SessionPersistenceNotFoundError) continue; throw error; }
          if (admittedMessages(otherEvents, request.id).length) throw fail('DSH_REQUEST_ID_REUSED');
        }
        if (admittedMessages(nativeEvents, request.id).length) {
          const proven = completedReply(nativeEvents, recorded);
          if (proven === null) throw fail('DSH_RESULT_UNKNOWN');
          companion?.record(request, proven);
          ledger.prepare("UPDATE requests SET state='completed',reply=? WHERE id=?").run(proven, request.id); return proven;
        }
        assertSettled(nativeEvents);
        await companion?.beforeTurn(request, binding.session_id);
        let handle = handles.get(request.mode);
        if (!handle) {
          const workspace = path.join(root, 'workspaces', request.mode); fs.mkdirSync(workspace, { recursive: true });
          const setup = agentCtx => { if (companion) companion.setup(agentCtx, request.mode); else agentCtx.systemPrompt.section({ name: 'chatagent:isolated-mode', order: 50, text: `Isolated Chatagent verification mode: ${request.mode}. No production persona or tools are loaded.` }); };
          const options = { agentOptions: { provider, model }, setup };
          handle = fresh ? await ctx.get('agents').create({ ...options, sessionId: binding.session_id, meta: { cwd: workspace } }) : await ctx.get('agents').resume({ ...options, resumeSessionId: binding.session_id });
          handles.set(request.mode, handle);
        }
        agent = handle.agent;
        companion?.prepareSurface(agent.session, llm.createUserMessage);
        agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: request.text }], source: { kind: FORMAT, requestId: request.id, mode: request.mode } }));
        await Promise.race([agent.whenIdle(), new Promise((_, reject) => { timer = setTimeout(() => reject(fail('DSH_TURN_TIMEOUT')), turnTimeoutMs); })]);
        await ctx.get('sessions').flush(agent.session);
        const output = completedReply(agent.session.snapshotEvents(), recorded);
        if (output === null) throw fail('DSH_FINAL_REPLY_UNPROVEN');
        companion?.record(request, output);
        ledger.prepare("UPDATE requests SET state='completed',reply=? WHERE id=?").run(output, request.id); return output;
      } catch (error) {
        if (!agent && ['DSH_REQUEST_ID_REUSED', 'DSH_LOG_REQUEST_CONFLICT'].includes(error.message)) {
          // 此行刚为未接纳的候选请求创建；冲突时撤销它，不能污染原请求的恢复身份。
          ledger.prepare("DELETE FROM requests WHERE id=? AND state='running'").run(request.id);
          if (!wasBound) ledger.prepare('DELETE FROM modes WHERE mode=? AND session_id=?').run(request.mode, binding.session_id);
          throw fail('DSH_REQUEST_ID_REUSED');
        }
        ledger.prepare("UPDATE requests SET state='unknown' WHERE id=?").run(request.id);
        agent?.cancel({ kind: 'user' });
        throw fail(error.message === 'DSH_REQUEST_ID_REUSED' ? error.message : 'DSH_RESULT_UNKNOWN');
      } finally { clearTimeout(timer); companion?.afterTurn(); }
    }
    return {
      kind: 'isolated-sdk', root,
      supportsAttachments: !!audioInput,
      attachModels: value => modelRouter?.attach(value),
      attachDelivery: binding => { audioInput?.attach(binding); companion?.attachDelivery(binding); },
      attachmentTranscription: id => { if(!audioInput)throw fail('ASR_NOT_CONNECTED');return audioInput.transcription(id); },
      transcribeAttachment(id) {
        if(closing||!audioInput)throw fail('ASR_NOT_CONNECTED');
        return audioInput.requestTranscription(id,action=>{const result=queue.then(action);queue=result.catch(()=>{});});
      },
      cancelCapabilities: () => companion?.capabilities.cancel(),
      afterReply(request, reply) {
        if (closing) return Promise.reject(fail('DSH_RUNTIME_CLOSED'));
        const selected = turnModels.get(request.id);
        const result = queue.then(() => {
          const input = request.attachments?.length ? audioInput?.lookup(request) : request;
          if (!input || input.failure) return;
          return modelRouter && selected ? modelRouter.run(selected, () => companion?.afterReply(input, reply)) : companion?.afterReply(input, reply);
        }).finally(() => turnModels.delete(request.id)); queue = result.catch(() => {}); return result;
      },
      companionStatus: () => {
        const status = companion?.status(); if (!status) return null;
        return modelRouter ? { ...status, kind: modelRouter.mode() === 'real' ? 'imported-companion-configured' : status.kind, modelMode: modelRouter.mode(), externalModel: modelRouter.mode() === 'real' } : status;
      },
      historyRecords: () => companion?.historyRecords?.() ?? [],
      memorySettings: () => { if(!companion?.memorySettings)throw fail('COMPANION_NOT_CONNECTED');return companion.memorySettings(); },
      saveMemorySettings: value => { const result=queue.then(()=>{if(!companion?.saveMemorySettings)throw fail('COMPANION_NOT_CONNECTED');return companion.saveMemorySettings(value);});queue=result.catch(()=>{});return result; },
      importMemory: value => {const result=queue.then(()=>{if(!companion?.importMemory)throw fail('COMPANION_NOT_CONNECTED');return companion.importMemory(value);});queue=result.catch(()=>{});return result;},
      workspaceInfo: () => ({ dataRoot:root, sessionsRoot, workspaces:['social','assistant','companion'].map(name=>({name,path:path.join(root,'workspaces',name),exists:fs.existsSync(path.join(root,'workspaces',name))})), pluginLoading:'explicit-sdk-services', memoryEngine:companion?'dsh-fish-memory':null }),
      companionArchive: (kind, offset) => { if (!companion) throw fail('COMPANION_NOT_CONNECTED'); return companion.archive(kind, offset); },
      contextStatus() {
        return { state: companion?.windowManaged ? 'recent_window_managed' : allowCompaction ? 'ready' : 'rehearsal_paused', modes: ['social', 'assistant'].map(mode => {
          const agent = handles.get(mode)?.agent;
          let measured; try { measured = agent && ctx.get('tokenMeter').measure(agent.session); } catch { /* unavailable is explicit */ }
          return { mode, tokens: measured?.totalTokens ?? null, tokenSource: measured ? measured.baseline?.kind ?? 'estimated' : 'unavailable', attempt: JSON.parse(ledger.prepare('SELECT body FROM context_attempts WHERE mode=?').get(mode)?.body ?? 'null') };
        }) };
      },
      maintainContext(settings) {
        if (closing || companion?.windowManaged || !allowCompaction) return Promise.resolve();
        const result = queue.then(async () => {
          for (const mode of ['social', 'assistant']) {
            const agent = handles.get(mode)?.agent; if (!agent || agent.status === 'running') continue;
            const measured = ctx.get('tokenMeter').measure(agent.session);
            const previous = JSON.parse(ledger.prepare('SELECT body FROM context_attempts WHERE mode=?').get(mode)?.body ?? 'null');
            const next = await maintainMode({ policy: { enabled: settings.policy.contextEnabled, maxTokens: settings.modes[mode].contextMaxTokens ?? settings.policy.contextMaxTokens }, measurement: measured,
              signature: hash(JSON.stringify(agent.session.surface.nodes)), previous, now: Date.now(), compact: () => ctx.get('compaction').compactNow(agent, AbortSignal.timeout(turnTimeoutMs)) });
            ledger.prepare('INSERT INTO context_attempts VALUES(?,?) ON CONFLICT(mode) DO UPDATE SET body=excluded.body').run(mode, JSON.stringify(next));
          }
        }); queue = result.catch(() => {}); return result;
      },
      reply(request) {
        if (closing) return Promise.reject(fail('DSH_RUNTIME_CLOSED'));
        if (request?.attachments?.length && !audioInput) return Promise.reject(fail('DSH_MEDIA_NOT_SUPPORTED'));
        if (!request || typeof request.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.id) || !['social', 'assistant'].includes(request.mode) || typeof request.text !== 'string' || !request.text.trim() && !request.attachments?.length || request.text.length > 32000) return Promise.reject(fail('INVALID_DSH_REQUEST'));
        const immutable = { id: request.id, mode: request.mode, text: request.text, persona: request.persona ? { ...request.persona } : null, maxMessages: request.maxMessages, ...(request.attachments?.length ? { attachments: structuredClone(request.attachments) } : {}) };
        const selected = modelRouter?.snapshot();
        const result = queue.then(async () => {
          const input = immutable.attachments?.length ? await audioInput.prepare(immutable) : immutable;
          if (input.failure) return input.failure;
          if (!selected) return execute(input);
          // Only public route metadata is persisted; no key or cipher enters the model transcript.
          const p = selected.profile;
          ledger.prepare('INSERT OR IGNORE INTO request_models VALUES(?,?)').run(immutable.id, JSON.stringify({ mode: selected.mode, revision: selected.revision, profileId: p?.id ?? null, model: p?.model ?? null }));
          turnModels.clear(); turnModels.set(immutable.id, selected);
          return modelRouter.run(selected, () => execute(input));
        }); queue = result.catch(() => {}); return result;
      },
      // 只核对原生证据，不调用followup/resume。供服务重启后补存已经生成的回复。
      lookupResult(request) {
        if (closing) return Promise.reject(fail('DSH_RUNTIME_CLOSED'));
        if (request?.attachments?.length && !audioInput) return Promise.reject(fail('DSH_MEDIA_NOT_SUPPORTED'));
        const result = queue.then(async () => {
          const input = request.attachments?.length ? audioInput.lookup(request) : request;
          if (input.failure) return input.failure;
          const immutable = { id: input.id, mode: input.mode, text_hash: hash(input.text) };
          const recorded = ledger.prepare('SELECT * FROM requests WHERE id=?').get(immutable.id);
          if (recorded && (recorded.mode !== immutable.mode || recorded.text_hash !== immutable.text_hash)) throw fail('DSH_REQUEST_ID_REUSED');
          const binding = ledger.prepare('SELECT session_id FROM modes WHERE mode=?').get(immutable.mode);
          try {
            const result = completedReply(await eventsFor(recorded?.session_id ?? binding?.session_id ?? sessionIdFor(immutable.mode)), immutable);
            if (result !== null) companion?.record(input, result);
            return result;
          } catch (error) {
            if (error instanceof persistenceApi.SessionPersistenceNotFoundError) return null;
            throw error;
          }
        });
        queue = result.catch(() => {}); return result;
      },
      checkpoint(destination, captureChat) {
        if (closing) return Promise.reject(fail('DSH_RUNTIME_CLOSED'));
        if (!path.isAbsolute(destination) || typeof captureChat !== 'function') return Promise.reject(fail('INVALID_CHECKPOINT_OPTIONS'));
        const relative = path.relative(root, destination);
        if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) return Promise.reject(fail('CHECKPOINT_INSIDE_RUNTIME'));
        const result = queue.then(async () => {
          plainDirectory(path.dirname(destination)); rejectLinks(root);
          // 即使上次超时已返回，也要等原生轮次真正停止后才能取一致快照。
          let timer;
          try {
            await Promise.race([Promise.all([...handles.values()].map(handle => handle.agent.whenIdle())),
              new Promise((_, reject) => { timer = setTimeout(() => reject(fail('DSH_CHECKPOINT_NOT_IDLE')), turnTimeoutMs); })]);
          } finally { clearTimeout(timer); }
          for (const handle of handles.values()) await ctx.get('sessions').flush(handle.agent.session);
          for (const binding of ledger.prepare('SELECT session_id FROM modes').all()) await eventsFor(binding.session_id);
          fs.mkdirSync(destination);
          fs.copyFileSync(path.join(root, '.chatagent-dsh.json'), path.join(destination, '.chatagent-dsh.json'), fs.constants.COPYFILE_EXCL);
          await backup(ledger, path.join(destination, 'requests.sqlite'));
          sealDatabase(path.join(destination, 'requests.sqlite'));
          if (fs.existsSync(path.join(root, 'sessions'))) copyTree(path.join(root, 'sessions'), path.join(destination, 'sessions'));
          if (fs.existsSync(path.join(root, 'workspaces'))) {
            fs.mkdirSync(path.join(destination, 'workspaces'));
            for (const name of fs.readdirSync(path.join(root, 'workspaces'))) {
              const target = path.join(destination, 'workspaces', name);
              if (name === 'companion' && companion) await companion.checkpoint(target);
              else copyTree(path.join(root, 'workspaces', name), target);
            }
          }
          await captureChat();
        });
        queue = result.catch(() => {}); return result;
      },
      status() { return { modeBindings: ledger.prepare('SELECT mode,session_id FROM modes ORDER BY mode').all(), requests: ledger.prepare('SELECT id,mode,state,session_id FROM requests ORDER BY rowid').all() }; },
      close() {
        closing = true;
        return closeJob ??= (async () => {
          await queue;
          try { for (const handle of handles.values()) await handle.dispose(); }
          finally { try { await companion?.close(); await ctx.fiber.dispose(); } finally { ledger.close(); release(); } }
        })();
      }
    };
  } catch (error) {
    try { await companion?.close(); if (ctx) await ctx.fiber.dispose(); } finally { if (ledger) ledger.close(); release(); }
    throw error;
  }
}
