// Imported writing is data, rendered only through textContent.
export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function dateKey(entry) {
  if (validDate(entry.date)) return entry.date;
  if (entry.at == null || !Number.isFinite(new Date(entry.at).getTime())) return 'undated';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(entry.at));
}
export function videoRecord(entry) {
  const text = String(entry.text ?? ''), lines = text.split('\n');
  const match = /^(.*) \((BV[A-Za-z0-9]{10})\)$/.exec(lines[0]);
  if (!match) return { ...entry, title: lines[0] || '未命名记录', bvid: null, feeling: text, note: '' };
  let note = '';
  if (/^(导入的历史记录；不会恢复旧阅读任务。|已读 \d+\/\d+ 页；未读取原始音频。)$/.test(lines.at(-1))) note = lines.pop();
  return { ...entry, title: match[1], bvid: match[2], feeling: lines.slice(1).join('\n'), note };
}
export function videoGroups(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const item = videoRecord(entry), key = item.bvid ?? 'record:' + entry.id;
    if (!groups.has(key)) groups.set(key, { title: item.title, bvid: item.bvid, entries: [] });
    groups.get(key).entries.push(item);
  }
  for (const group of groups.values()) group.entries.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return [...groups.values()];
}
// A failed or cancelled page must never produce a seemingly complete date index.
export async function readAllPages(readPage, cancelled = () => false) {
  const entries = [];
  for (let offset = 0; ; ) {
    const page = await readPage(offset);
    if (cancelled()) return null;
    if (!Array.isArray(page.entries)) throw Error('资料格式不完整，请刷新重试。');
    entries.push(...page.entries); offset += page.entries.length;
    if (page.total != null && offset >= page.total || page.total == null && page.entries.length < 50) return entries;
    if (!page.entries.length) throw Error('资料读取中断，日期索引尚未完整。');
  }
}
if (typeof document !== 'undefined') await startArchive();

async function startArchive() {
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const button = (label, action, cls = 'soft-button') => { const n = el('button', cls, label); n.type = 'button'; n.onclick = action; return n; };
  const labels = { memories: '记忆', history: '聊天原文', diaries: '鱼的小本本', 'bili-legacy': '导入的 B 站历史', bili: '本空间 B 站内容记录' };
  let token, offset = 0, generation = 0, rows = [], selectedDate = '', month = '', ready = false;
  const dated = () => ['diaries', 'bili-legacy', 'bili'].includes($('kind').value);
  const today = () => dateKey({ at: Date.now() });
  const dates = () => [...new Set(rows.map(dateKey))].sort().reverse();
  const dateLabel = key => key === 'undated' ? '日期不详' : key;
  async function request(route, method = 'GET') {
    const response = await fetch(route, { method, headers: { 'X-Chatagent-Token': token } });
    if (!response.ok) throw Error('资料暂时无法读取，请保留原数据并刷新重试。');
    return response.json();
  }
  function setCalendarOpen(open) {
    $('calendar').hidden = !open; $('calendar-button').setAttribute('aria-expanded', String(open));
    if (open) { renderCalendar(); $('calendar').querySelector('[aria-pressed="true"]')?.focus(); }
  }
  function chooseDate(key) {
    selectedDate = key; if (validDate(key)) month = key.slice(0, 7);
    $('date-input').value = validDate(key) ? key : '';
    $('record-dates').value = dates().includes(key) ? key : '';
    const url = new URL(location.href); url.searchParams.set('date', key); history.replaceState(null, '', url);
    renderDated(); renderCalendar();
  }
  function renderCalendar() {
    const [year, m] = month.split('-').map(Number);
    $('month-label').textContent = `${year} 年 ${m} 月`;
    const grid = $('calendar-days'); grid.replaceChildren();
    const first = new Date(Date.UTC(year, m - 1, 1)).getUTCDay(), days = new Date(Date.UTC(year, m, 0)).getUTCDate();
    const counts = new Map(); for (const row of rows) counts.set(dateKey(row), (counts.get(dateKey(row)) ?? 0) + 1);
    for (let n = 0; n < first; n++) grid.append(el('span'));
    for (let d = 1; d <= days; d++) {
      const key = month + '-' + String(d).padStart(2, '0'), count = counts.get(key) ?? 0;
      const day = button(String(d), () => { chooseDate(key); setCalendarOpen(false); $('calendar-button').focus(); }, 'calendar-day');
      day.setAttribute('aria-label', `${key}，${count ? count + ' 条记录' : '无记录'}`);
      day.setAttribute('aria-pressed', String(selectedDate === key));
      if (count) day.classList.add('has-records');
      if (key === today()) day.classList.add('is-today'); grid.append(day);
    }
  }
  function moveMonth(delta) {
    const date = new Date(month + '-01T00:00:00Z'); date.setUTCMonth(date.getUTCMonth() + delta);
    const next = date.toISOString().slice(0, 7); if (/^\d{4}-\d{2}$/.test(next)) { month = next; renderCalendar(); }
  }
  function emptyState(title, detail) { const box = el('div', 'archive-empty'); box.append(el('span', 'empty-mark', '◷'), el('h2', '', title), el('p', '', detail)); return box; }
  function renderDated() {
    const diary = $('kind').value === 'diaries', entries = rows.filter(row => dateKey(row) === selectedDate);
    const target = $('entries'); target.replaceChildren(); target.className = diary ? 'diary-layout' : 'bili-list';
    $('selected-date-title').textContent = dateLabel(selectedDate);
    $('selected-date-count').textContent = diary ? `${entries.length} 篇日记` : `${videoGroups(entries).length} 个视频 · ${entries.length} 条记录`;
    if (diary) {
      const rail = el('section', 'notebook-info'); rail.append(el('div', 'notebook-symbol', '▤'), el('h2', '', '小鲸鱼的记事本'), el('p', '', '把一起度过的日子，一页一页留在这里。'));
      const stats = el('div', 'notebook-stats'); stats.append(el('strong', '', String(rows.length)), el('span', '', '篇已保存日记')); rail.append(stats);
      rail.append(el('p', 'archive-footnote', '这里展示导入的日记原文。写日记的自动任务保持暂停。'));
      const nav = el('nav', 'diary-date-list'); nav.setAttribute('aria-label', '日记日期');
      for (const key of dates()) { const b = button(dateLabel(key), () => chooseDate(key)); b.classList.toggle('selected', key === selectedDate); b.setAttribute('aria-pressed', String(key === selectedDate)); nav.append(b); }
      rail.append(nav); target.append(rail);
      const reading = el('div', 'diary-reading');
      if (!entries.length) reading.append(emptyState('这一天还没有日记', '可以打开日历，选择带蓝点的日期。'));
      for (const entry of entries) {
        const article = el('article', 'diary-sheet'); article.dataset.entryId = entry.id;
        article.append(el('div', 'diary-dateline', dateLabel(selectedDate)), el('h2', '', '小鲸鱼的小本本'), el('p', 'diary-origin', '来自保存的日记 · 原文阅读'), el('div', 'diary-prose', entry.text ?? '')); reading.append(article);
      }
      target.append(reading);
    } else {
      if (!entries.length) target.append(emptyState('这一天没有浏览记录', rows.length ? '选择有记录的日期，看看她当时的感受。' : '当前来源还没有保存的记录，可以切换到导入的 B 站历史。'));
      for (const group of videoGroups(entries)) {
        const card = el('article', 'video-card'), top = el('div', 'video-heading'), title = el('div');
        title.append(el('h2', '', group.title), el('p', 'video-meta', `${group.bvid ?? '未识别视频编号'} · ${group.entries.length} 条记录`)); top.append(title);
        if (group.bvid) {
          const url = 'https://www.bilibili.com/video/' + group.bvid;
          const copy = button('复制视频链接', async () => { try { await navigator.clipboard.writeText(url); copy.textContent = '已复制链接'; } catch { copy.textContent = '请在展开后复制链接'; } }); top.append(copy);
        }
        card.append(top);
        const details = el('details', 'video-feelings'); details.append(el('summary', '', `展开感受（${group.entries.length} 条）`));
        if (group.bvid) details.append(el('p', 'video-url', 'https://www.bilibili.com/video/' + group.bvid));
        for (const entry of group.entries) {
          const feeling = el('div', 'feeling');
          feeling.append(el('time', '', entry.at == null || !Number.isFinite(new Date(entry.at).getTime()) ? '时间不详' : new Date(entry.at).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })), el('p', '', entry.feeling));
          if (entry.note && $('kind').value === 'bili') feeling.append(el('small', '', entry.note)); details.append(feeling);
        }
        card.append(details); target.append(card);
      }
    }
  }
  async function load(reset = false, keepDate = false) {
    const current = reset ? ++generation : generation, kind = $('kind').value;
    $('more').disabled = true; $('refresh').disabled = true; $('error').textContent = '';
    const requestedDate = keepDate ? selectedDate : new URLSearchParams(location.search).get('date');
    if (reset) {
      ready = false; offset = 0; rows = []; $('entries').replaceChildren(); $('entries').className = '';
      $('date-tools').hidden = true; $('date-heading').hidden = true; $('more').hidden = true; setCalendarOpen(false);
      $('record-dates').replaceChildren(); $('archive-title').textContent = labels[kind]; document.title = '小鲸鱼 · ' + labels[kind];
      $('archive-intro').textContent = kind === 'diaries' ? '她写下的日常，和你一起收藏。' : kind.startsWith('bili') ? '看过的片段，留下的感受。按北京时间整理。' : '保存在这台电脑上的独立资料副本。';
      $('reading-note').hidden = !kind.startsWith('bili');
    }
    $('loading').textContent = '正在读取记录…';
    try {
      const readPage = at => request('/v1/companion/archive?kind=' + kind + '&offset=' + at);
      if (dated()) {
        const all = await readAllPages(readPage, () => current !== generation); if (all === null) return;
        rows = all; ready = true; $('record-dates').append(new Option('选择有记录的日期', ''));
        for (const key of dates()) { const count = rows.filter(row => dateKey(row) === key).length; $('record-dates').append(new Option(`${dateLabel(key)} · ${count} ${kind === 'diaries' ? '篇日记' : '条记录'}`, key)); }
        $('date-tools').hidden = false; $('date-heading').hidden = false; month = today().slice(0, 7);
        chooseDate(validDate(requestedDate) || requestedDate === 'undated' ? requestedDate : dates()[0] ?? today());
      } else {
        const page = await readPage(offset); if (current !== generation) return;
        for (const entry of page.entries) {
          const details = el('details', 'plain-record'), summary = el('summary'), body = el('p', '', entry.text ?? '');
          summary.textContent = [entry.date ?? (entry.at ? new Date(entry.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : ''), entry.outgoing === true ? '小鲸鱼' : entry.outgoing === false ? '你' : '', (entry.text ?? '').slice(0, 65)].filter(Boolean).join(' · ');
          details.append(summary, body); $('entries').append(details);
        }
        offset += page.entries.length; $('more').hidden = page.entries.length < 50 || page.total != null && offset >= page.total;
        if (!offset) $('entries').append(emptyState('还没有这一类记录', '导入资料后可以在这里查看。'));
      }
    } catch (error) { if (current === generation) $('error').textContent = error.message; }
    finally { if (current === generation) { $('loading').textContent = ''; $('more').disabled = false; $('refresh').disabled = false; } }
  }
  const selectedKind = new URLSearchParams(location.search).get('kind');
  if ([...$('kind').options].some(option => option.value === selectedKind)) $('kind').value = selectedKind;
  $('kind').onchange = () => { const url = new URL(location.href); url.searchParams.set('kind', $('kind').value); url.searchParams.delete('date'); location.assign(url); };
  $('more').onclick = () => load(); $('refresh').onclick = () => load(true, true);
  $('calendar-button').onclick = () => setCalendarOpen($('calendar').hidden);
  $('calendar-close').onclick = () => { setCalendarOpen(false); $('calendar-button').focus(); };
  $('calendar').onkeydown = event => { if (event.key === 'Escape') { setCalendarOpen(false); $('calendar-button').focus(); } };
  $('month-back').onclick = () => moveMonth(-1); $('month-next').onclick = () => moveMonth(1);
  $('date-input').onchange = () => { if (ready && validDate($('date-input').value)) chooseDate($('date-input').value); };
  $('record-dates').onchange = () => { if (ready && $('record-dates').value) chooseDate($('record-dates').value); };
  $('today').onclick = () => { if (ready) chooseDate(today()); };
  $('cancel-capabilities').onclick = async () => { try { await request('/v1/companion/cancel', 'POST'); $('capabilities').textContent = '已请求停止，已保存的文字和附件会保留。'; } catch (error) { $('error').textContent = error.message; } };
  try {
    const boot = await (await fetch('/v1/bootstrap')).json(); token = boot.token;
    const status = await request('/v1/companion');
    if (status.capabilities) {
      const names = { singing: '歌曲翻唱', voice: '语音回复', bili: 'B站内容阅读' };
      $('capabilities').textContent = Object.entries(status.capabilities.ready).map(([key, connected]) => `${names[key]}：${connected ? '所需服务已配置' : '未启用，所需服务未接齐'}`).join(' · ');
      if (status.capabilities.components?.voiceSynthesis && !status.capabilities.components.voiceIntent) $('capabilities').textContent += '。语音合成可用，语音意图尚未接入。';
      $('cancel-capabilities').hidden = !status.capabilities.busy;
    }
    if (status.kind === 'not-connected') { $('status').textContent = '此服务尚未导入资料'; $('more').hidden = true; $('kind').disabled = true; $('refresh').disabled = true; }
    else {
      $('status').textContent = '本地档案'; $('summary').textContent = `记忆 ${status.memories} 条 · 保留删除记录 ${status.deletedMemories} 条 · 聊天 ${status.historyRecords} 条`;
      $('plugins').textContent = '插件：' + status.plugins.map(p => p.id + (p.active ? ' 已加载' : ' 未启用')).join('，'); await load(true);
    }
  } catch (error) { $('status').textContent = '连接失败'; $('error').textContent = error.message; }
}
