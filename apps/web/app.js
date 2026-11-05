import {chatFetch,chatId,chatUrl} from './chat-scope.js';
import { BubbleArrival } from './bubble-arrival.js';
import { outboxAction } from './outbox.js';
import { hiddenVoiceNotice, displayedText } from './message-presentation.js';

const $ = id => document.getElementById(id);
async function startChat() {
  const arrivals=new BubbleArrival();
  const players = new Map();
  const transcriptionJobs = new Map();
  let positionTimer,voiceScrubbing=false;
  function showPosition(seconds,total) { clearTimeout(positionTimer);$('voice-position').hidden=false;$('voice-position').textContent=`拖动到 ${seconds.toFixed(1)} 秒 / ${total.toFixed(1)} 秒`; }
  function hidePosition() { clearTimeout(positionTimer);positionTimer=setTimeout(()=>{$('voice-position').hidden=true;},1500); }
  document.addEventListener('visibilitychange', () => { if (document.hidden){arrivals.reset();renderKey="";for (const player of players.values()) player.audio.pause();} });
  window.addEventListener('pagehide', () => { for (const player of players.values()) { player.audio.pause(); URL.revokeObjectURL(player.url); } players.clear(); });
  const emptyTemplate = $('messages').firstElementChild.cloneNode(true);
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(chatId==='default'?'chatagent-local-v1':'chatagent-local-v1-'+chatId, 2);
    request.onupgradeneeded = () => {
      for (const name of ['state', 'files']) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  function access(mode, operation, name = 'state') {
    return new Promise((resolve, reject) => {
      const tx = database.transaction(name, mode), request = operation(tx.objectStore(name));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('LOCAL_SAVE_FAILED'));
    }).catch(error => { throw new Error('LOCAL_SAVE_FAILED', { cause: error }); });
  }
  let state = await access('readonly', store => store.get('main')) ?? { deviceId: crypto.randomUUID(), epoch: null, cursor: 0, messages: [], outbox: [], draft: '' };
  let token = null, refreshJob = null, submitting = false, fileBusy = false, mediaModel = false, connected = false, renderKey = '';
  let searchActive = false, timelineCursor = null, timelineGeneration=0;
  let historyRows = [], historyPageBefore = null, commitQueue = Promise.resolve();
  // 网络等待不占本机提交队列；只有已提交的副本才能被刷新或发送循环读取。
  function serial(operation) {
    const pending = commitQueue.then(operation);
    commitQueue = pending.catch(() => {});
    return pending;
  }
  function change(operation) {
    return serial(async () => {
      const next = structuredClone(state);
      if (operation(next) === false) return false;
      await access('readwrite', store => store.put(next, 'main'));
      state = next;
      return true;
    });
  }
  const labels = { queued: '已保存 · 等待处理', awaiting_confirmation: '积压超过时限 · 等待确认', running: '正在处理', completed: '已完成', unknown: '结果待核对 · 不会自动重试', cancelled: '已取消', failed: '处理失败' };
  const errors = { LOCAL_SAVE_FAILED: '本机保存未完成，请保留此窗口中的内容后重试。', MESSAGE_STATE_CHANGED: '消息状态已改变，请刷新后查看。', MESSAGE_ID_REUSED: '消息编号冲突，原消息已保留。', AUTH_REQUIRED: '连接已更新，正在重新连接。', INVALID_MESSAGE: '消息或时间无效，请检查内容和电脑时间。', MODE_CHANGED: '聊天连接已变化，请核对待发消息后确认补发。', MODE_EXPECTATION_REQUIRED: '请核对这条待发消息后确认补发。', ARCHIVE_CHANGED: '资料已恢复或切换，正在重新核对消息。' };
  errors.BACKUP_IN_PROGRESS = '正在备份，消息已保留在本机，备份完成后会继续同步。';
  Object.assign(errors, { LOCAL_FILE_MISSING: '本机附件副本缺失，请重新选择同一个文件后重试。', FILE_LIMIT: '每条消息最多8个文件，每个文件不超过64 MiB。', ATTACHMENT_HASH_MISMATCH: '附件完整性校验失败，文件未被接纳。', ATTACHMENT_OBJECT_DAMAGED: '电脑上的附件校验失败，未下载损坏内容。', FILE_CACHE_DAMAGED: '本机附件缓存校验失败，未打开损坏内容。' });
  function showError(error) { $('error').textContent = errors[error.message] ?? '操作未完成，内容已保留。请检查本地服务后重试。'; $('error').hidden = false; }
  async function api(route, body) {
    const response = await chatFetch(route, { signal: AbortSignal.timeout(15000), method: body === undefined ? 'GET' : 'POST', headers: { 'X-Chatagent-Token': token ?? '', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) { if (response.status === 401) token = null; throw new Error(result.error); }
    return result;
  }
  const fileHash = async blob => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  async function transcribe(file) {
    if(transcriptionJobs.has(file.sha256))return;
    const job=(async()=>{
      const save=async text=>{await change(next=>{(next.audioTranscripts??={})[file.sha256]=text;});render();};
      await save('正在转文字…');
      try{
        let result=await api(`/v1/attachments/${file.id}/transcription`,{}),deadline=Date.now()+610000;
        while(['queued','running'].includes(result.state)&&Date.now()<deadline){await new Promise(r=>setTimeout(r,1500));result=await api(`/v1/attachments/${file.id}/transcription`);}
        await save(result.state==='completed'?result.text:result.state==='unknown'?'转文字结果待核对，没有自动重试。':'这段语音未能可靠转成文字。');
      }catch{await save('转文字连接中断，请长按重新查看。');}
    })();transcriptionJobs.set(file.sha256,job);try{await job;}finally{transcriptionJobs.delete(file.sha256);}
  }
  async function uploadFiles(item, stillEligible) {
    for (const file of item.files ?? []) {
      if (!await stillEligible()) return false;
      let remote = await api('/v1/attachments', file);
      if (remote.state === 'ready') continue;
      const blob = await access('readonly', store => store.get(file.sha256), 'files');
      if (!blob) throw Error('LOCAL_FILE_MISSING');
      if (blob.size !== file.bytes || await fileHash(blob) !== file.sha256) throw Error('FILE_CACHE_DAMAGED');
      while (remote.offset < file.bytes) {
        if (!await stillEligible()) return false;
        const response = await chatFetch(`/v1/attachments/${file.id}/content?offset=${remote.offset}`, { method: 'PUT', signal: AbortSignal.timeout(15000),
          headers: { 'X-Chatagent-Token': token ?? '', 'Content-Type': 'application/octet-stream' }, body: blob.slice(remote.offset, remote.offset + 1024 * 1024) });
        const next = await response.json();
        if (!response.ok) { if (response.status === 401) token = null; throw Error(next.error); }
        if (next.offset <= remote.offset || next.offset > file.bytes) throw Error('ATTACHMENT_OFFSET_CONFLICT');
        remote = next;
      }
      if (!await stillEligible()) return false;
      await api(`/v1/attachments/${file.id}/complete`, {});
    }
    return true;
  }
  async function loadFile(file) {
    let blob = await access('readonly', store => store.get(file.sha256), 'files');
    if (!blob) {
      const response = await chatFetch(`/v1/attachments/${file.id}/content`, { signal: AbortSignal.timeout(60000), headers: { 'X-Chatagent-Token': token ?? '' } });
      if (!response.ok) { if (response.status === 401) token = null; throw Error((await response.json()).error); }
      blob = await response.blob();
      if (blob.size !== file.bytes || await fileHash(blob) !== file.sha256) throw Error('ATTACHMENT_HASH_MISMATCH');
      await access('readwrite', store => store.put(blob, file.sha256), 'files');
    } else if (blob.size !== file.bytes || await fileHash(blob) !== file.sha256) throw Error('FILE_CACHE_DAMAGED');
    return blob;
  }
  async function downloadFile(file) {
    const url = URL.createObjectURL(await loadFile(file)), link = document.createElement('a'); link.href = url; link.download = file.name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function mergeRows(previous, incoming) {
    const rows = new Map(previous.map(row => [row.id, row]));
    for (const row of incoming) if (!rows.has(row.id) || (rows.get(row.id).revision ?? 0) <= (row.revision ?? 0)) rows.set(row.id, row);
    const order=r=>r.source?r.id:'live-'+String(r.seq??0).padStart(20,'0')+'-'+r.id;
    return [...rows.values()].sort((a,b)=>a.created_at-b.created_at||(order(a)<order(b)?-1:order(a)>order(b)?1:0));
  }
  function applyMode(next, result, force = false) {
    if (!['social', 'assistant'].includes(result.mode) || !Number.isSafeInteger(result.modeRevision)) return;
    if (force || !Number.isSafeInteger(next.modeRevision) || result.modeRevision >= next.modeRevision) {
      next.mode = result.mode; next.modeRevision = result.modeRevision;
    }
  }
  function prune(next) {
    const cutoff = Date.now() - 30 * 86400000;
    const removed = next.messages.filter(row => row.created_at <= cutoff && !['queued', 'awaiting_confirmation', 'unknown', 'running'].includes(row.state));
    // 缓存淘汰后，手动历史入口仍须覆盖刚移出的记录。
    if (removed.length) next.historyBefore = Math.max(next.historyBefore ?? 1, ...removed.map(row => row.seq + 1));
    next.messages = next.messages.filter(row => row.created_at > cutoff || ['queued', 'awaiting_confirmation', 'unknown', 'running'].includes(row.state));
    next.prunedAt = Date.now();
  }
  const deliveryAction = (item, current = state) => outboxAction(item, current.epoch, Date.now(), { mode: current.mode, modeRevision: current.modeRevision });
  function render() {
    if(voiceScrubbing)return;
    $('send').disabled = submitting || fileBusy;
    $('choose-file').disabled = submitting || fileBusy;
    $('file-input').disabled = submitting || fileBusy;
    const visibleRows = (searchActive ? historyRows : mergeRows(historyRows, state.messages)).filter(row => !hiddenVoiceNotice(row));
    const key = JSON.stringify([visibleRows, state.outbox, state.draftFiles, state.audioTranscripts, mediaModel, fileBusy, [...players.keys()]]); if (key === renderKey&&!arrivals.ready(Date.now())) return; renderKey = key;
    $('draft-files').replaceChildren();
    for (const file of state.draftFiles ?? []) {
      const line = document.createElement('div'); line.className = 'draft-file';
      const name = document.createElement('span'); name.textContent = `${file.name} · ${(file.bytes / 1024).toFixed(1)} KiB`;
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '移除 ' + file.name; remove.disabled = submitting || fileBusy;
      remove.onclick = async () => { try { await change(next => { next.draftFiles = (next.draftFiles ?? []).filter(row => row.id !== file.id); }); render(); } catch (error) { showError(error); } };
      line.append(name, remove); $('draft-files').append(line);
    }
    const messages = $('messages'), previousScrollTop=messages.scrollTop, atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
    messages.replaceChildren();
    if (!visibleRows.length && !state.outbox.length) messages.append(emptyTemplate.cloneNode(true));
    arrivals.prime(visibleRows.map(row=>row.id));
    for (const row of visibleRows) {
      const arrival=arrivals.state(row.id,row.role==='assistant'&&!row.source&&!searchActive,row.created_at,Date.now());if(arrival<0)continue;
      const article = document.createElement('article'); article.className = 'message ' + row.role;
      const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = displayedText(row);
      const meta = document.createElement('div'); meta.className = 'meta';
      const status = row.state === 'queued' && row.attachments?.length && !mediaModel ? '已保存 · 等待附件处理能力' : labels[row.state] ?? row.state;
      meta.textContent = `${row.source?.unknownTime?'时间不详':new Date(row.created_at).toLocaleString('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false })}${['completed','queued','running'].includes(row.state) ? '' : ' · ' + status}`;
      if(row.source){const origin=document.createElement('small');origin.className='meta';origin.textContent='来自 '+row.source.sourceId+' · '+row.source.scope+(row.source.missingAttachments.length?' · '+row.source.missingAttachments.length+' 个附件仅保留元数据':'');article.append(origin);}
      if (displayedText(row)) article.append(bubble);
      for (const file of row.attachments ?? []) {
        if (file.mediaType?.startsWith('audio/')) {
          const key = row.id + ':' + file.id;
          const play = document.createElement('button'); play.className = 'voice-bar';
          const icon = document.createElement('span'); icon.className = 'voice-waves'; icon.setAttribute('aria-hidden', 'true');
          for (let i = 0; i < 3; i++) icon.append(document.createElement('i'));
          const label = document.createElement('span'); label.className = 'voice-duration';
          const progress = document.createElement('span'); progress.className = 'voice-progress'; progress.setAttribute('aria-hidden', 'true');
          play.append(icon, label, progress);
          const update = () => {
            const audio = players.get(key)?.audio, playing = audio && !audio.paused && !audio.ended;
            const seconds = Number.isFinite(audio?.duration) ? Math.max(1, Math.ceil(audio.duration)) : file.durationMs>0?Math.ceil(file.durationMs/1000):0;
            label.textContent = seconds ? `${seconds}″` : '读取时长…';
            play.classList.toggle('playing', !!playing); play.setAttribute('aria-label', `${row.role === 'user' ? '我的' : '小鲸鱼的'}语音，点击播放或停止，再次播放从头开始，长按转文字或拖动进度${seconds ? `，${seconds}秒` : ''}`);
            progress.style.width = audio?.duration > 0 ? `${Math.min(100, audio.currentTime / audio.duration * 100)}%` : '0%';
          };
          if (players.has(key)) players.get(key).update = update;
          const startAt = async (position=0) => {
            play.disabled = true; label.textContent = '加载中…';
            try {
              let player = players.get(key);
              if (!player) {
                const blob = await loadFile(file), audio = document.createElement('audio'); audio.preload = 'metadata';
                const url = URL.createObjectURL(new Blob([blob], { type: file.mediaType })); audio.src = url;
                player = { audio, url, update }; players.set(key, player);
                for (const event of ['loadedmetadata', 'timeupdate', 'play', 'pause', 'ended']) audio.addEventListener(event, () => player.update());
                audio.addEventListener('error', () => { player.update(); label.textContent = '点按重试'; });
              }
              if (!document.hidden) {
                for (const other of players.values()) if (other !== player) other.audio.pause();
                player.audio.currentTime=Math.max(0,position);
                await player.audio.play();
              }
            } catch (error) { showError(error); } finally { play.disabled = false; update(); }
          };
          const menu=document.createElement('div');menu.className='voice-menu';menu.hidden=true;
          const convert=document.createElement('button');convert.type='button';convert.textContent='转文字';convert.onclick=()=>{menu.hidden=true;void transcribe(file);};
          const replay=document.createElement('button');replay.type='button';replay.textContent='从头播放';replay.onclick=()=>{menu.hidden=true;void startAt(0);};menu.append(convert,replay);
          const openMenu=()=>{for(const other of document.querySelectorAll('.voice-menu'))other.hidden=true;menu.hidden=false;};
          let holdTimer,seek=null,suppressClick=false;
          play.onclick=()=>{if(suppressClick){suppressClick=false;return;}const audio=players.get(key)?.audio;if(audio&&!audio.paused&&!audio.ended){audio.pause();audio.currentTime=0;update();return;}return startAt(0);};
          play.addEventListener('contextmenu',event=>{event.preventDefault();openMenu();});
          play.addEventListener('pointerdown',event=>{if(event.button!==0)return;suppressClick=false;const audio=players.get(key)?.audio;seek={x:event.clientX,y:event.clientY,origin:audio?.currentTime??0,total:audio?.duration||file.durationMs/1000||0,armed:false,dragging:false,resume:audio&&!audio.paused,target:audio?.currentTime??0};holdTimer=setTimeout(()=>{if(!seek)return;seek.armed=true;voiceScrubbing=true;try{play.setPointerCapture(event.pointerId);}catch{}showPosition(seek.target,seek.total);},500);});
          play.addEventListener('pointermove',event=>{if(!seek)return;const delta=event.clientX-seek.x;if(!seek.armed){if(Math.abs(delta)>10||Math.abs(event.clientY-seek.y)>10){clearTimeout(holdTimer);seek=null;suppressClick=true;}return;}if(seek.total>0&&(seek.dragging||Math.abs(delta)>8)){seek.dragging=true;players.get(key)?.audio.pause();seek.target=Math.max(0,Math.min(seek.total,seek.origin+delta/Math.max(1,play.getBoundingClientRect().width-32)*seek.total));showPosition(seek.target,seek.total);progress.style.width=`${seek.target/seek.total*100}%`;}});
          play.addEventListener('pointerup',()=>{voiceScrubbing=false;clearTimeout(holdTimer);if(!seek)return;if(seek.armed){suppressClick=true;if(seek.dragging)void startAt(Math.min(seek.target,Math.max(0,seek.total-.001)));else openMenu();hidePosition();}seek=null;});
          play.addEventListener('pointercancel',()=>{voiceScrubbing=false;clearTimeout(holdTimer);if(seek?.resume&&!document.hidden)void players.get(key)?.audio.play();seek=null;suppressClick=true;hidePosition();});
          update(); article.append(play,menu);
          if(state.audioTranscripts?.[file.sha256]){const transcript=document.createElement('div');transcript.className='voice-transcript';transcript.textContent=state.audioTranscripts[file.sha256];article.append(transcript);}
          continue;
        }
        const button = document.createElement('button'); button.className = 'attachment'; button.textContent = `下载：${file.name} · ${(file.bytes / 1024).toFixed(1)} KiB`;
        button.onclick = async () => { button.disabled = true; try { await downloadFile(file); } catch (error) { showError(error); } finally { button.disabled = false; } };
        article.append(button);
      }
      article.append(meta);
      if (row.role === 'user' && row.state === 'awaiting_confirmation') {
        const actions = document.createElement('div'); actions.className = 'actions';
        for (const action of row.state === 'awaiting_confirmation' ? ['confirm', 'cancel'] : ['cancel']) {
          const button = document.createElement('button'); button.textContent = action === 'confirm' ? '确认继续' : '取消'; button.className = action;
          button.onclick = async () => {
            try {
              const epoch = await serial(() => state.epoch);
              const result = await api(`/v1/messages/${row.id}/decision`, { action, revision: row.revision });
              await change(next => { if (next.epoch !== epoch) return false; next.messages = mergeRows(next.messages, [result]); });
              render(); await refresh();
            } catch (error) { showError(error); }
          };
          actions.append(button);
        }
        article.append(actions);
      }
      messages.append(article);
      if(arrival===1&&!matchMedia('(prefers-reduced-motion: reduce)').matches)article.animate([{opacity:0,transform:'translateY(8px)'},{opacity:1,transform:'translateY(0)'}],{duration:220,easing:'ease-out'});
    }
    for (const [key, player] of players) if (!visibleRows.some(row => (row.attachments ?? []).some(file => row.id + ':' + file.id === key))) { player.audio.pause(); URL.revokeObjectURL(player.url); players.delete(key); }
    messages.scrollTop = atBottom ? messages.scrollHeight : previousScrollTop;
    $('outbox').replaceChildren();
    for (const item of state.outbox) {
      if(state.messages.some(row=>row.client_id===item.clientMessageId&&row.device===state.deviceId))continue;
      const line = document.createElement('div'); line.className = 'message user';
      const text = document.createElement('span');text.className='bubble';text.textContent=item.text || (item.files?.length?'语音或附件':'');line.append(text);

      if (item.hold) {
        const button = document.createElement('button'); button.textContent = '确认补发';
        button.onclick = async () => {
          try {
            await change(next => {
              const pending = next.outbox.find(row => row.clientMessageId === item.clientMessageId); if (!pending) return false;
              pending.hold = false; pending.holdReason = null; pending.confirmedAt = Date.now(); pending.epoch = next.epoch;
              pending.expectedMode = next.mode; pending.expectedModeRevision = next.modeRevision;
            });
            render(); await refresh();
          } catch (error) { showError(error); }
        };
        line.append(button);
      }
      const cancel = document.createElement('button'); cancel.textContent = '移除待发';
      cancel.onclick = async () => {
        // 移除本机待发副本，不宣称撤销服务器可能已经执行的操作。
        try { await change(next => { next.outbox = next.outbox.filter(row => row.clientMessageId !== item.clientMessageId); }); render(); }
        catch (error) { showError(error); }
      };
      cancel.hidden=!item.hold;line.append(cancel);line.oncontextmenu=event=>{event.preventDefault();cancel.hidden=false;};messages.append(line);
    }
    messages.scrollTop = atBottom ? messages.scrollHeight : previousScrollTop;
  }
  async function syncMessages() {
    let result;
    do {
      const query = await serial(() => ({ epoch: state.historyBefore === undefined || state.cacheSince === undefined ? '' : state.epoch, cursor: state.audioMetadataVersion===2?state.cursor:0 }));
      result = await api(`/v1/sync?epoch=${encodeURIComponent(query.epoch ?? '')}&after=${query.cursor}`);
      const needsCommit = await serial(() => state.audioMetadataVersion!==2 || result.reset || result.messages.length || result.cursor !== state.cursor ||
        result.modeRevision !== state.modeRevision || Date.now() - (state.prunedAt ?? 0) >= 60000);
      if (needsCommit) await change(next => {
        next.messages = mergeRows(result.reset ? [] : next.messages, result.messages);
        if(result.messages.every(row=>(row.attachments??[]).every(file=>!file.mediaType?.startsWith('audio/')||Object.hasOwn(file,'durationMs'))))next.audioMetadataVersion=2;
        applyMode(next, result, result.reset);
        next.epoch = result.epoch; next.cursor = result.cursor;
        if (result.reset) {
          next.historyBefore = result.historyBefore; next.cacheSince = result.cacheSince;
          next.cacheBefore = result.historyBefore; next.cacheComplete = result.historyBefore <= 1;
        }
        prune(next);
      });
      if (result.reset) { arrivals.reset(); renderKey=''; historyRows = []; historyPageBefore = null; $('older').textContent = '查看更早的消息'; }
      else {
        const updates = new Map(result.messages.map(row => [row.id, row]));
        historyRows = historyRows.map(row => updates.get(row.id)?.revision >= row.revision ? updates.get(row.id) : row);
      }
    } while (result.hasMore);
  }
  async function fillCache() {
    // 每轮最多回填三页，让发送与后续刷新也能及时推进；进度与内容在同一事务落盘。
    for (let page = 0; page < 3; page++) {
      const query = await serial(() => state.cacheComplete ? null : { epoch: state.epoch, before: state.cacheBefore, since: state.cacheSince });
      if (!query) return;
      const result = await api(`/v1/cache?epoch=${encodeURIComponent(query.epoch)}&before=${query.before}&since=${query.since}`);
      await change(next => {
        if (next.epoch !== query.epoch || next.cacheBefore !== query.before || next.cacheSince !== query.since || result.epoch !== query.epoch) return false;
        next.messages = mergeRows(next.messages, result.messages); next.cacheBefore = result.nextBefore; next.cacheComplete = !result.hasMore;
        prune(next);
      });
    }
  }
  async function drainOutbox() {
    const ids = await serial(() => state.outbox.map(item => item.clientMessageId));
    for (const clientId of ids) {
      const query = await serial(() => state.outbox.some(item => item.clientMessageId === clientId) ? { device: state.deviceId, epoch: state.epoch } : null);
      if (!query) continue;
      const known = await api(`/v1/messages/lookup?deviceId=${encodeURIComponent(query.device)}&clientMessageId=${encodeURIComponent(clientId)}`);
      if (!known) {
        const pending = await serial(() => state.outbox.find(row => row.clientMessageId === clientId));
        const eligible = () => serial(() => {
          const current = state.outbox.find(row => row.clientMessageId === clientId);
          return !!current && state.epoch === query.epoch && !['hold', 'hold_mode'].includes(deliveryAction(current));
        });
        if (pending?.files?.length && await eligible()) await uploadFiles(pending, eligible);
      }
      // 把最后的已落盘状态核对及网络请求启动放入同一提交队列，避免越过尚未完成的本机修改。
      const dispatch = await serial(() => {
        const item = state.outbox.find(row => row.clientMessageId === clientId);
        if (!item || state.epoch !== query.epoch) return null;
        const action = deliveryAction(item);
        if (known) {
          const confirmation = action === 'submit_and_confirm' && known.state === 'awaiting_confirmation' && known.mode === item.expectedMode;
          return { known: true, response: confirmation ? api(`/v1/messages/${known.id}/decision`, { action: 'confirm', revision: known.revision }) : Promise.resolve(known) };
        }
        if (action === 'hold' || action === 'hold_mode') return { hold: true };
        return { known: false, response: api('/v1/messages', { deviceId: state.deviceId, clientMessageId: item.clientMessageId, text: item.text, queuedAt: item.queuedAt, expectedMode: item.expectedMode, expectedModeRevision: item.expectedModeRevision, attachmentIds: (item.files ?? []).map(file => file.id) }) };
      });
      if (!dispatch) continue;
      if (dispatch.hold) {
        await change(next => {
          const item = next.outbox.find(row => row.clientMessageId === clientId); if (!item) return false;
          const action = deliveryAction(item, next); if (action !== 'hold' && action !== 'hold_mode') return false;
          item.hold = true; if (action === 'hold_mode') item.holdReason = 'mode';
        });
        break;
      }
      let accepted;
      try { accepted = await dispatch.response; }
      catch (error) {
        if (['MODE_CHANGED', 'MODE_EXPECTATION_REQUIRED'].includes(error.message)) await change(next => {
          const item = next.outbox.find(row => row.clientMessageId === clientId); if (!item) return false;
          item.hold = true; item.holdReason = 'mode';
        });
        throw error;
      }
      await change(next => { if (next.epoch !== query.epoch) return false; next.messages = mergeRows(next.messages, [accepted]); });
      if (!dispatch.known && accepted.state === 'awaiting_confirmation') {
        const confirmation = await serial(() => {
          const item = state.outbox.find(row => row.clientMessageId === clientId);
          return item && state.epoch === query.epoch && accepted.mode === item.expectedMode && deliveryAction(item) === 'submit_and_confirm'
            ? { response: api(`/v1/messages/${accepted.id}/decision`, { action: 'confirm', revision: accepted.revision }) } : null;
        });
        if (confirmation) accepted = await confirmation.response;
      }
      await change(next => {
        if (next.epoch !== query.epoch) return false;
        next.messages = mergeRows(next.messages, [accepted]); next.outbox = next.outbox.filter(item => item.clientMessageId !== clientId);
      });
    }
  }
  async function performRefresh() {
    try {
      if (!token) {
        const boot = await api('/v1/bootstrap'); token = boot.token;
        mediaModel = boot.mediaModel === true;
        $('backup-note').textContent = boot.backupScope === 'chat-and-isolated-dsh' ? '备份此聊天已保存的消息、附件与独立 DSH 资料。' : boot.backupScope === 'unsupported-backend' ? '当前后端尚不支持联合备份。' : '备份此聊天已保存的消息与电脑上的附件。';
        $('backend').textContent = boot.backend === 'dsh-bridge' ? '已连接 DSH 的 Chatagent 专用会话。模型、记忆和工具由 DSH 管理。' : boot.backend === 'not-connected' ? '备用 DSH 尚未连接。消息可以本地保存，暂时不会获得小鲸鱼回复。' : boot.modelMode === 'real' ? '使用独立配置的对话模型。模型选择可在“模型与连接”查看；人格、记忆和历史仍保存在本机。' : '当前是隔离演练空间；模型响应使用本地替身。导入情况可在“搬家档案”查看，微信继续正常使用。';
        await change(next => applyMode(next, boot, next.epoch !== boot.epoch));
      }
      await syncMessages(); render(); await drainOutbox(); await fillCache();
      connected = true;
      $('connection').textContent = state.cacheComplete ? '● 本地空间已连接 · 消息持久保存' : '● 本地空间已连接 · 正在补齐最近30天历史';
      await drainOutbox();
    } catch (error) {
      if (['MODE_CHANGED', 'MODE_EXPECTATION_REQUIRED'].includes(error.message)) showError(error);
      else {
        token = null; connected = false; $('connection').textContent = '○ 本地服务未连接 · 可继续写消息';
        if (!['Failed to fetch', 'Load failed', 'AUTH_REQUIRED'].includes(error.message)) showError(error);
      }
    } finally { render(); }
  }
  function refresh() {
    if (!refreshJob) refreshJob = performRefresh().finally(() => { refreshJob = null; });
    return refreshJob;
  }
  $('text').value = state.draft;
  $('choose-file').onclick = () => $('file-input').click();
  $('file-input').onchange = async () => {
    if (fileBusy || submitting) return;
    fileBusy = true; render();
    try {
      const selected = [...$('file-input').files];
      if ((state.draftFiles?.length ?? 0) + selected.length > 8 || selected.some(file => file.size > 64 * 1024 * 1024)) throw Error('FILE_LIMIT');
      const prepared = [];
      for (const file of selected) {
        const sha256 = await fileHash(file);
        await access('readwrite', store => store.put(file.slice(0, file.size, 'application/octet-stream'), sha256), 'files');
        prepared.push({ id: crypto.randomUUID(), name: file.name, bytes: file.size, sha256 });
      }
      await change(next => { next.draftFiles = [...next.draftFiles ?? [], ...prepared]; });
      $('error').hidden = true;
    } catch (error) { showError(error); }
    finally { fileBusy = false; $('file-input').value = ''; render(); }
  };
  $('text').addEventListener('input', () => {
    const draft = $('text').value;
    void change(next => { next.draft = draft; }).catch(showError);
  });
  $('text').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); } });
  $('composer').onsubmit = async event => {
    event.preventDefault(); const text = $('text').value; if (submitting || fileBusy || (!text.trim() && !state.draftFiles?.length)) return;
    submitting = true; $('send').disabled = true; $('text').disabled = true;
    try {
      const id = crypto.randomUUID(), queuedAt = Date.now();
      await change(next => {
        next.outbox.push({ clientMessageId: id, text, files: next.draftFiles ?? [], queuedAt, epoch: next.epoch, hold: false, expectedMode: next.mode, expectedModeRevision: next.modeRevision });
        next.draft = ''; next.draftFiles = [];
      });
      $('text').value = ''; $('error').hidden = true;
    } catch (error) { showError(error); }
    finally { submitting = false; $('text').disabled = false; render(); }
    await refresh();
  };
  async function loadTimeline(reset=false) {
    $('older').disabled=true;
    const generation=reset?++timelineGeneration:timelineGeneration;
    try {
      if(reset){historyRows=[];timelineCursor=null;}
      const params=new URLSearchParams({q:$('history-query').value,date:$('history-date').value,type:$('history-type').value});
      searchActive=Boolean(params.get('q')||params.get('date')||params.get('type'));
      if(timelineCursor)params.set('before',timelineCursor);
      const result=await api('/v1/timeline?'+params);
      if(generation!==timelineGeneration)return;
      historyRows=mergeRows(historyRows,result.messages);timelineCursor=result.nextBefore;
      $('older').textContent=result.hasMore?'查看更早的消息':'已到最早的消息';
      render();
    }catch(error){showError(error);}finally{$('older').disabled=false;}
  }
  $('older').onclick=()=>loadTimeline();
  $('history-find').onclick=()=>loadTimeline(true);
  $('history-clear').onclick=()=>{$('history-query').value='';$('history-date').value='';$('history-type').value='';timelineGeneration++;historyRows=[];timelineCursor=null;searchActive=false;render();};
  $('backup').onclick = async () => { $('backup').disabled = true; try { const result = await api('/v1/backups', {}); $('backup-result').textContent = `备份已校验：${result.messages} 条消息。` + (result.coverage.includes('chatagent.attachments') ? '已包含电脑附件。' : '') + (result.coverage.includes('chatagent.isolated-dsh') ? '包含独立 DSH 会话与请求账本。' : '范围仅为此本地空间。'); } catch (error) { showError(error); } finally { $('backup').disabled = false; } };
  disableControls(false);
  render(); await refresh(); setInterval(refresh, 1000); const arrivalTimer=setInterval(()=>{if(!document.hidden&&arrivals.ready(Date.now()))render();},100);window.addEventListener('pagehide',()=>clearInterval(arrivalTimer),{once:true}); window.addEventListener('online', refresh);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

function disableControls(disabled) {
  for (const element of document.querySelectorAll('button, textarea, select')) element.disabled = disabled;
}
function unavailable(message) { disableControls(true); $('connection').textContent = message; }
disableControls(true);
if (!navigator.locks) unavailable('当前浏览器不能安全保存离线队列，请使用新版浏览器。');
else navigator.locks.request('chatagent-local-writer', { ifAvailable: true }, async lock => {
  if (!lock) {
    unavailable('此浏览器已有聊天窗口，请在原窗口继续。');
    $('error').textContent = '为保护离线消息，此窗口暂停编辑。关闭原窗口后刷新本页即可继续。'; $('error').hidden = false;
    return;
  }
  await startChat();
  await new Promise(() => {});
}).catch(() => unavailable('本机消息缓存未能打开，请刷新后重试。'));
