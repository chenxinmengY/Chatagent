import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { startService } from '../apps/service/server.mjs';
import {BubbleArrival} from '../apps/web/bubble-arrival.js';
import { outboxAction } from '../apps/web/outbox.js';
import { hiddenVoiceNotice, displayedText } from '../apps/web/message-presentation.js';
import { sandbox } from './helpers.mjs';
import { wav } from '../packages/companion-capabilities/media.mjs';

const source = fs.readFileSync(new URL('../apps/web/app.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
const scopeSource=fs.readFileSync(new URL('../apps/web/chat-scope.js',import.meta.url),'utf8').replace(/^export /gm,'');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const nativeFetch = fetch;
const defer = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw Error('CLIENT_TEST_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, 1)); }
}
function element(tag = 'div') {
  return { tag, value: '', disabled: false, hidden: true, textContent: '', scrollHeight: 0, scrollTop: 0, clientHeight: 100, children: [], events: {}, style: {}, classList: { toggle() {} }, paused: true,
    animate(){}, setAttribute(name, value) { this[name] = value; }, async play() { this.paused = false; }, pause() { this.paused = true; },
    setPointerCapture() {}, getBoundingClientRect() { return {width:232}; },
    append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = [...items]; this.scrollTop=0; }, cloneNode() { return element(tag); },
    addEventListener(name, handler) { this.events[name] = handler; } };
}
function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }

// 执行真实 app.js：仅替换浏览器DOM、IndexedDB事务时序；HTTP实际连接隔离服务和SQLite。
async function client(service, { saved, savedFiles = new Map(), beforeFetch, afterFetch, beforePut, beforeFilePut, scope='default' } = {}) {
  const ids = new Map(), intervals = [], requests = [], writes = [], paused = [];
  const get = id => { if (!ids.has(id)) ids.set(id, element()); return ids.get(id); };
  get('messages').firstElementChild = element();
  let persisted = structuredClone(saved);
  const files = new Map(savedFiles);
  const database = { transaction(name) {
    const tx = { error: null, objectStore() { return {
      get(key) { const request = { result: structuredClone(name === 'files' ? files.get(key) : persisted) }; queueMicrotask(() => tx.oncomplete()); return request; },
      put(value, key) {
        const snapshot = structuredClone(value), request = { result: 'main' };
        const write = { snapshot, complete() { if (name === 'files') files.set(key, structuredClone(snapshot)); else persisted = structuredClone(snapshot); tx.oncomplete(); }, fail() { tx.error = Object.assign(Error('QuotaExceededError'), { name: 'QuotaExceededError' }); tx.onerror(); } };
        if (name === 'files') { queueMicrotask(() => beforeFilePut?.(snapshot) === 'fail' ? write.fail() : write.complete()); return request; }
        writes.push(write);
        if (beforePut?.(snapshot) === 'pause') paused.push(write); else queueMicrotask(write.complete);
        return request;
      }
    }; } }; return tx;
  } };
  const databaseNames=[];const indexedDB = { open(name) { databaseNames.push(name);const request = { result: database }; queueMicrotask(() => request.onsuccess()); return request; } };
  const createdAudio = [], documentEvents = {};
  const document = { hidden: false, addEventListener(name,handler) { documentEvents[name]=handler; }, getElementById: get, createElement(tag) { const el=element(tag);if(tag==='audio')createdAudio.push(el);return el; }, querySelectorAll: () => [] };
  const mockFetch = async (route, options = {}) => {
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    requests.push({ route, body, method: options.method }); await beforeFetch?.(route, body);
    const response = await nativeFetch(service.url + route, options); await afterFetch?.(route, response); return response;
  };
  await new AsyncFunction('document', 'indexedDB', 'crypto', 'navigator', 'fetch', 'outboxAction', 'hiddenVoiceNotice', 'displayedText', 'window', 'setInterval','location','BubbleArrival','matchMedia', scopeSource+'\n'+source)(
    document, indexedDB, webcrypto, { locks: { request: (_name, _options, callback) => callback({}) } }, mockFetch, outboxAction, hiddenVoiceNotice, displayedText,
    { addEventListener() {} }, callback => intervals.push(callback),{search:scope==='default'?'':'?chat='+scope,origin:service.url},BubbleArrival,()=>({matches:false}));
  return { databaseNames,get, requests, writes, paused, createdAudio, document, documentEvents, savedFiles: () => new Map(files), saved: () => structuredClone(persisted), ready: () => until(() => intervals.length >= 1),
    choose(file) { get('file-input').files = [file]; return get('file-input').onchange(); },
    refresh: () => intervals[0](), arrivals:()=>intervals[1]?.(),
    send(text) { get('text').value = text; return get('composer').onsubmit({ preventDefault() {} }); },
    button(id, text) { const found = descendants(get(id)).find(node => node.textContent === text); assert.ok(found, `Missing button: ${text}`); return found; } };
}
async function fixture(t, options = {}) {
  let service;
  t.after(() => service?.close());
  const box = sandbox(t);
  service = await startService({ dataRoot: path.join(box.root, 'client-service'), ...options });
  return service;
}
const input = (id, queuedAt = Date.now()) => ({ deviceId: 'client-fixture', clientMessageId: id, text: '合成消息 ' + id, queuedAt });

test('实际前端：多条新气泡逐条显示，离开再打开不隐藏已保存的回复',async t=>{
 const service=await fixture(t),browser=await client(service);await browser.ready();
 for(const id of ['arrival-one','arrival-two','arrival-three'])service.store.publish({deliveryId:id,text:id});
 await browser.refresh();const shown=()=>descendants(browser.get('messages')).filter(n=>n.className==='bubble').map(n=>n.textContent);
 assert.deepEqual(shown(),['arrival-one']);assert.equal(browser.saved().messages.length,3);
 await new Promise(r=>setTimeout(r,900));browser.arrivals();assert.deepEqual(shown(),['arrival-one','arrival-two']);
 browser.document.hidden=true;browser.documentEvents.visibilitychange();browser.document.hidden=false;await browser.refresh();assert.deepEqual(shown(),['arrival-one','arrival-two','arrival-three']);
});
test('实际前端：待发消息优先于历史补齐，不因后台下载推迟提交',async t=>{
 const service=await fixture(t),at=Date.now();for(let i=0;i<5;i++){const row=service.store.submit(input('prior-'+i,at-1000));service.store.decide(row.id,row.revision,'cancel');}
 const initial=await client(service);await initial.ready();const saved=initial.saved();saved.cacheComplete=false;saved.cacheBefore=5;
 saved.outbox.push({clientMessageId:'priority-outbox',text:'SYNTHETIC_PRIORITY',queuedAt:at,epoch:saved.epoch,hold:false,expectedMode:saved.mode,expectedModeRevision:saved.modeRevision});
 const resumed=await client(service,{saved});await resumed.ready();const submit=resumed.requests.findIndex(r=>r.route==='/v1/messages'&&r.method==='POST'),cache=resumed.requests.findIndex(r=>r.route.startsWith('/v1/cache?'));assert.ok(submit>=0&&cache>submit);assert.equal(resumed.saved().outbox.length,0);
});

test('实际前端：独立聊天使用独立缓存并把消息、同步和查重固定到创建它的聊天',async t=>{
 const backend=id=>({kind:'dsh-bridge',externalRuntime:true,status:()=>({modeBindings:[{mode:'social',session_id:id}]}),bridgeStatus:async()=>({tools:[]}),openChat:async id=>backend(id),reply:async()=> '测试回复'});
 const service=await fixture(t,{backend:backend('default'),preferencesSeed:{personas:[{id:'role',name:'测试角色',text:'独立人格',categoryId:null}],activePersonaId:'role'}}),boot=await(await nativeFetch(service.url+'/v1/bootstrap')).json(),id=webcrypto.randomUUID();
 const created=await nativeFetch(service.url+'/v1/chats',{method:'POST',headers:{'X-Chatagent-Token':boot.token,'Content-Type':'application/json'},body:JSON.stringify({id,name:'独立测试',personaId:'role'})});assert.equal(created.status,200);
 const original=await client(service),child=await client(service,{scope:id});await original.ready();await child.ready();assert.deepEqual(original.databaseNames,['chatagent-local-v1']);assert.deepEqual(child.databaseNames,['chatagent-local-v1-'+id]);
 await child.send('只发送到新角色');await child.refresh();assert.equal(service.store.history().length,0);assert.ok(child.requests.some(r=>r.route==='/v1/chats/'+id+'/v1/messages'&&r.method==='POST'));assert.equal(child.requests.some(r=>r.route==='/v1/messages'&&r.method==='POST'),false);assert.equal(child.saved().messages[0].text,'只发送到新角色');
});

test('实际前端：播放音频更新渲染缓存，刷新复用播放器，字节校验后才播放', async t => {
  const service = await fixture(t), file = path.join(service.root, 'test.wav');
  const wave = Buffer.alloc(48); wave.write('RIFF'); wave.writeUInt32LE(40, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22); wave.writeUInt32LE(24000, 24); wave.writeUInt32LE(48000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(4, 40); fs.writeFileSync(file, wave);
  const row = service.attachments.importFile(file);
  service.store.publish({ deliveryId: 'audio-player', text: '本地测试音', attachments: [{ id: row.id, name: row.name, bytes: row.bytes, sha256: row.sha256, mediaType: row.media_type }] });
  const browser = await client(service); await browser.ready();
  const bar=()=>descendants(browser.get('messages')).find(e=>e.className==='voice-bar');
  assert.ok(bar());assert.equal(descendants(browser.get('messages')).some(e=>e.className==='attachment'),false);
  await bar().onclick();const player=browser.createdAudio[0];assert.ok(player);assert.equal(player.paused,false);
  player.currentTime=12;browser.get("messages").scrollHeight=2000;browser.get("messages").scrollTop=1200;await browser.refresh();assert.equal(browser.get("messages").scrollTop,1200);await bar().onclick();assert.equal(player.paused,true);assert.equal(player.currentTime,0);await bar().onclick();assert.equal(player.paused,false);assert.equal(player.currentTime,0);
  assert.equal(browser.createdAudio.length,1);assert.equal(browser.requests.filter(r => r.route.endsWith('/content')).length,1);
  browser.document.hidden=true;browser.documentEvents.visibilitychange();assert.equal(player.paused,true);
  URL.revokeObjectURL(player.src);
});

test('实际前端：未播放的长语音可长按定位，输入框上方显示秒数，松手定位且再次点击停止、第三次从头播放', async t => {
  const service=await fixture(t),file=path.join(service.root,'long.wav');fs.writeFileSync(file,wav(Buffer.alloc(16000*2*125),16000));
  const row=service.attachments.importFile(file);service.store.publish({deliveryId:'seek-preview',text:'长语音',attachments:[{id:row.id,name:row.name,bytes:row.bytes,sha256:row.sha256,mediaType:row.media_type}]});
  const browser=await client(service);await browser.ready();const bar=descendants(browser.get('messages')).find(e=>e.className==='voice-bar');
  assert.equal(bar.children[1].textContent,'125″');assert.equal(browser.createdAudio.length,0);
  bar.events.pointerdown({button:0,clientX:100,clientY:10,pointerId:1});await new Promise(resolve=>setTimeout(resolve,550));
  bar.events.pointermove({clientX:200,clientY:10});assert.equal(browser.get('voice-position').hidden,false);assert.match(browser.get('voice-position').textContent,/62\.5 秒.*125\.0 秒/);
  bar.events.pointerup();await until(()=>browser.createdAudio.length===1&&!browser.createdAudio[0].paused);const audio=browser.createdAudio[0];assert.equal(audio.currentTime,62.5);
  await bar.onclick();assert.equal(audio.currentTime,62.5);await bar.onclick();assert.equal(audio.currentTime,0);assert.equal(audio.paused,true);await bar.onclick();assert.equal(audio.paused,false);assert.equal(audio.currentTime,0);
  bar.events.contextmenu({preventDefault(){}});assert.equal(descendants(browser.get('messages')).find(e=>e.className==='voice-menu').hidden,false);
  browser.document.hidden=true;browser.documentEvents.visibilitychange();URL.revokeObjectURL(audio.src);
});

test('实际前端：附件字节先落盘，重载保留草稿文件，空文字也能提交一次文件消息', async t => {
  const service = await fixture(t), browser = await client(service); await browser.ready();
  const file = new File(['synthetic file only'], '合成附件.txt');
  await browser.choose(file);
  assert.equal(browser.saved().draftFiles.length, 1); assert.equal(browser.savedFiles().size, 1);
  const reloaded = await client(service, { saved: browser.saved(), savedFiles: browser.savedFiles() }); await reloaded.ready();
  await reloaded.send(''); await reloaded.refresh();
  const rows = service.store.history(); assert.equal(rows.length, 1); assert.equal(rows[0].text, '');
  assert.equal(rows[0].attachments[0].name, file.name); assert.equal(reloaded.saved().outbox.length, 0);
  assert.equal(fs.readFileSync(service.attachments.verify(rows[0].attachments[0].id).file, 'utf8'), 'synthetic file only');
  assert.equal(service.attachments.count(), 1);
});

test('实际前端：附件缓存写入失败时不登记草稿引用、不上传或提交文件', async t => {
  const service = await fixture(t), browser = await client(service, { beforeFilePut: () => 'fail' }); await browser.ready();
  await browser.choose(new File(['synthetic never saved'], '保存失败.txt'));
  assert.equal(browser.saved().draftFiles?.length ?? 0, 0); assert.equal(browser.savedFiles().size, 0);
  await browser.send(''); await browser.refresh();
  assert.equal(service.attachments.count(), 0); assert.equal(service.store.history().length, 0);
  assert.match(browser.get('error').textContent, /本机保存未完成/);
});

test('实际前端：上传首片响应丢失后按服务器持久偏移续传，原文件和消息ID不变', async t => {
  const service = await fixture(t); let lost = false;
  const browser = await client(service, { afterFetch(route) { if (route.includes('/content?offset=0') && !lost) { lost = true; throw Error('Failed to fetch'); } } });
  await browser.ready(); const content = Buffer.alloc(1024 * 1024 + 7, 42);
  await browser.choose(new File([content], '断点续传.bin')); await browser.send('');
  assert.equal(service.store.history().length, 0); assert.equal(browser.saved().outbox.length, 1);
  const pending = browser.saved().outbox[0]; assert.equal(service.attachments.get(pending.files[0].id).offset, 1024 * 1024);
  const restarted = await client(service, { saved: browser.saved(), savedFiles: browser.savedFiles() }); await restarted.ready();
  assert.equal(restarted.requests.filter(row => row.route.includes('/content?')).length, 1);
  assert.ok(restarted.requests.some(row => row.route.endsWith('/content?offset=1048576')));
  assert.equal(service.store.history().length, 1); assert.equal(service.store.history()[0].client_id, pending.clientMessageId);
  assert.deepEqual(fs.readFileSync(service.attachments.verify(pending.files[0].id).file), content);
});

test('实际前端：上传期间移除待发消息，已开始分片结束后也不能继续提交该消息', async t => {
  const service = await fixture(t), gate = defer(); let entered = false;
  const browser = await client(service, { beforeFetch(route) { if (route.includes('/content?')) { entered = true; return gate.promise; } } });
  await browser.ready(); await browser.choose(new File(['synthetic cancelled upload'], '取消.bin'));
  const sending = browser.send(''); await until(() => entered);
  await browser.button('messages', '移除待发').onclick(); gate.resolve(); await sending; await browser.refresh();
  assert.equal(browser.saved().outbox.length, 0); assert.equal(service.store.history().length, 0);
  assert.equal(browser.requests.filter(row => row.route === '/v1/messages').length, 0);
});

test('实际前端：消息落盘失败时并发刷新不能发送未提交队列，草稿不被网络等待阻塞', async t => {
  const service = await fixture(t), syncGate = defer(); let syncEntered = false;
  const browser = await client(service, {
    beforeFetch(route) { if (route.startsWith('/v1/sync') && !syncEntered) { syncEntered = true; return syncGate.promise; } },
    beforePut(snapshot) { if (snapshot.outbox.some(row => row.text === 'SYNTHETIC_SAVE_FAILURE')) return 'pause'; }
  });
  await until(() => syncEntered);
  browser.get('text').value = '网络等待期间的合成草稿'; browser.get('text').events.input();
  await until(() => browser.saved()?.draft === '网络等待期间的合成草稿');
  const sending = browser.send('SYNTHETIC_SAVE_FAILURE');
  await until(() => browser.paused.length === 1); syncGate.resolve();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(browser.requests.filter(row => row.route === '/v1/messages').length, 0);
  browser.paused[0].fail(); await sending; await browser.ready();
  assert.equal(service.store.history().length, 0);
  assert.equal(browser.saved().outbox.length, 0);
  assert.equal(browser.get('text').value, 'SYNTHETIC_SAVE_FAILURE');
  assert.match(browser.get('error').textContent, /本机保存未完成/);
});

test('实际前端：确认未落盘时不能补发，保存失败保留原待确认状态', async t => {
  const service = await fixture(t), now = Date.now(), syncGate = defer(); let pauseSync = false, syncEntered = false;
  const saved = { deviceId: 'confirmation-test', epoch: service.store.epoch, cursor: 0, messages: [], draft: '', mode: 'social', modeRevision: 0,
    outbox: [{ clientMessageId: 'held', text: 'SYNTHETIC_HELD', queuedAt: now - 31 * 60000, epoch: service.store.epoch, hold: true, expectedMode: 'social', expectedModeRevision: 0 }] };
  const browser = await client(service, { saved,
    beforeFetch(route) { if (pauseSync && route.startsWith('/v1/sync')) { syncEntered = true; return syncGate.promise; } },
    beforePut(snapshot) { if (snapshot.outbox.some(row => row.confirmedAt !== undefined)) return 'pause'; }
  });
  await browser.ready(); pauseSync = true; const refreshing = browser.refresh(); await until(() => syncEntered);
  const confirming = browser.button('messages', '确认补发').onclick(); await until(() => browser.paused.length === 1);
  syncGate.resolve(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(browser.requests.filter(row => row.route === '/v1/messages').length, 0);
  browser.paused[0].fail(); await confirming; await refreshing;
  assert.equal(service.store.history().length, 0); assert.equal(browser.saved().outbox[0].hold, true);
  assert.equal(browser.saved().outbox[0].confirmedAt, undefined); assert.match(browser.get('error').textContent, /本机保存未完成/);
});

test('实际前端：中断后按已落盘游标补齐450条近期消息，手动历史不跳过中间记录', async t => {
  let now = Date.now() - 40 * 86400000;
  const service = await fixture(t, { now: () => now });
  const blocker = service.store.submit(input('old-unknown', now)); service.store.claim(); service.store.unknown(blocker.id);
  const old = service.store.submit(input('old-history', now)); service.store.decide(old.id, old.revision, 'cancel');
  now = Date.now();
  for (let i = 0; i < 450; i++) { const row = service.store.submit(input('recent-' + i, now)); service.store.decide(row.id, row.revision, 'cancel'); }
  let pages = 0;
  const first = await client(service, { beforeFetch(route) { if (route.startsWith('/v1/cache') && ++pages === 2) throw Error('Failed to fetch'); } });
  await first.ready(); const checkpoint = first.saved();
  assert.equal(checkpoint.messages.length, 401); assert.equal(checkpoint.cacheComplete, false); assert.equal(checkpoint.cacheBefore, 53); assert.equal(checkpoint.historyBefore, 253);
  const resumed = await client(service, { saved: checkpoint }); await resumed.ready();
  assert.equal(new URL(resumed.requests.find(row => row.route.startsWith('/v1/cache')).route, service.url).searchParams.get('before'), '53');
  assert.equal(resumed.saved().cacheComplete, true); assert.equal(resumed.saved().messages.length, 451);
  assert.equal(resumed.saved().messages.filter(row => row.client_id?.startsWith('recent-')).length, 450);
  await resumed.get('older').onclick();
  assert.ok(resumed.requests.some(row => row.route.startsWith('/v1/timeline?')));
  for(let i=0;i<4;i++)await resumed.get('older').onclick();
  assert.equal(descendants(resumed.get('messages')).filter(n=>n.className==='bubble').length,452);
  assert.ok(descendants(resumed.get('messages')).some(n=>n.textContent==='合成消息 old-history'));
  assert.equal(resumed.saved().historyBefore, 253, '仅在内存的手动历史不能推进持久游标');
  const again = await client(service, { saved: resumed.saved() }); await again.ready(); await again.get('older').onclick();
  assert.ok(again.requests.some(row => row.route.startsWith('/v1/timeline?') && !new URL(row.route,service.url).searchParams.has('before')));
  const writes = again.writes.length; await again.refresh();
  assert.equal(again.writes.length, writes, '空同步不应每次重写完整缓存');
});

test('实际前端：离线期间模式变化必须确认，旧消息身份保持且按确认后的模式提交', async t => {
  const service = await fixture(t); let offline = false;
  const browser = await client(service, { beforeFetch() { if (offline) throw Error('Failed to fetch'); } });
  await browser.ready(); offline = true; await browser.send('SYNTHETIC_MODE_CHANGE');
  const originalId = browser.saved().outbox[0].clientMessageId;
  service.store.setMode('assistant'); offline = false; await browser.refresh();
  assert.equal(browser.saved().outbox[0].holdReason, 'mode');
  assert.equal(service.store.history().length, 0);
  await browser.button('messages', '确认补发').onclick();
  assert.equal(browser.saved().outbox.length, 0); assert.equal(service.store.history().length, 1);
  assert.equal(service.store.history()[0].client_id, originalId); assert.equal(service.store.history()[0].mode, 'assistant');
});

test('实际前端：提交瞬间模式版本冲突停发，不把409误判为成功或自动升级', async t => {
  const service = await fixture(t); let switched = false;
  const browser = await client(service, { beforeFetch(route) { if (route === '/v1/messages' && !switched) { switched = true; service.store.setMode('assistant'); } } });
  await browser.ready(); await browser.send('SYNTHETIC_MODE_RACE');
  assert.equal(service.store.history().length, 0); assert.equal(browser.saved().outbox[0].hold, true);
  assert.match(browser.get('error').textContent, /聊天连接已变化/);
  const id = browser.saved().outbox[0].clientMessageId;
  await browser.refresh(); await browser.button('messages', '确认补发').onclick();
  assert.equal(service.store.history().length, 1); assert.equal(service.store.history()[0].client_id, id); assert.equal(service.store.history()[0].mode, 'assistant');
});

test('实际前端：旧队列缺失模式先查重，已有记录不重发，未知记录等确认', async t => {
  const service = await fixture(t), now = Date.now();
  const known = service.store.submit({ deviceId: 'legacy-device', clientMessageId: 'known', text: 'SYNTHETIC_ALREADY_ACCEPTED', queuedAt: now });
  const saved = { deviceId: 'legacy-device', epoch: service.store.epoch, cursor: 0, messages: [], outbox: [
    { clientMessageId: 'known', text: known.text, queuedAt: now, epoch: service.store.epoch, hold: false },
    { clientMessageId: 'new-legacy', text: 'SYNTHETIC_LEGACY_UNKNOWN', queuedAt: now, epoch: service.store.epoch, hold: false }
  ], draft: '' };
  const browser = await client(service, { saved }); await browser.ready();
  assert.equal(browser.saved().outbox.length, 1); assert.equal(browser.saved().outbox[0].clientMessageId, 'new-legacy');
  assert.equal(browser.saved().outbox[0].holdReason, 'mode'); assert.equal(browser.requests.filter(row => row.route === '/v1/messages').length, 0);
  assert.equal(service.store.history().length, 1);
});
