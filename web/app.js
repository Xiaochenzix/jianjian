/* Shared UI; native hosts expose only a narrow, local-origin bridge. */
const $ = id => document.getElementById(id);
const nativePending = new Map(); let nativeCounter = 0;
window.__nativeResult = (id, result, error) => { const p = nativePending.get(id); if (!p) return; nativePending.delete(id); clearTimeout(p.timer); error ? p.reject(new Error(error)) : p.resolve(result); };
let nativeListener = () => {};
window.__nativeEvent = event => nativeListener(event);
const bridge = window.jianjian || (window.AndroidBridge ? {
  invoke: (method, value) => new Promise((resolve, reject) => {
    const id = ++nativeCounter;
    const timer = setTimeout(() => { nativePending.delete(id); reject(new Error('设备操作超时')); }, 30000);
    nativePending.set(id, { resolve, reject, timer });
    window.AndroidBridge.postMessage(JSON.stringify({ id, method, value }));
  }),
  onEvent: cb => { nativeListener = cb; }
} : null);
const defaults = { autoSend: false, autoWrite: false, autoStart: false, background: false };
let state = { session: null, prefs: { ...defaults }, info: { platform: 'Web', name: '网页设备', clipboard: false, background: false }, items: [], devices: [], filter: '', q: '', nextBefore: null, connected: false };
let eventAbort, reconnectTimer, toastTimer, searchTimer, refreshGeneration = 0, uploadBusy = false, destroyed = false;
let loadingMore = false, sending = false, composing = false, viewportFrame, viewportBase = 0, viewportWidth = 0;
let attachments = [], uploadRequest = null;
let appReady = false, pendingFocusMessage = null;
const activeLoads = new Set();
const deviceKey = localStorage.getItem('jianjian-device-key') || crypto.randomUUID();
localStorage.setItem('jianjian-device-key', deviceKey);
const platformIcon = p => ({ Android: '▯', Windows: '▣', macOS: '▱', Linux: '▣', Web: '◎' }[p] || '▣');
const platformName = p => ({ Android: '安卓', Windows: 'Win', macOS: 'Mac', Linux: 'Linux', Web: 'Web' }[p] || '设备');
function toast(message) {
  const target = $('toast');
  clearTimeout(toastTimer); target.textContent = message;
  if (typeof target.showPopover === 'function') {
    target.setAttribute('popover', 'manual');
    Object.assign(target.style, { margin: '0', border: '0', right: 'auto', bottom: 'auto' });
    target.classList.remove('hidden');
    if (!target.matches(':popover-open')) target.showPopover();
  } else {
    // Older WebViews still need the notice inside the modal's top layer.
    const host = [...document.querySelectorAll('dialog[open]')].at(-1) || document.body;
    host.append(target); target.classList.remove('hidden');
  }
  toastTimer = setTimeout(() => {
    if (typeof target.hidePopover === 'function' && target.matches(':popover-open')) target.hidePopover();
    target.classList.add('hidden');
    if (target.parentElement !== document.body) document.body.append(target);
  }, 4000);
}
function element(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function scrollState() {
  const scroller = $('conversation-scroll');
  if (!scroller) return { bottom: true };
  const top = scroller.getBoundingClientRect().top;
  const cards = [...$('timeline').querySelectorAll('[data-message-id]')];
  const anchor = cards.find(card => card.getBoundingClientRect().bottom > top + 1);
  return { bottom: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 64, top: scroller.scrollTop, height: scroller.scrollHeight, id: anchor?.dataset.messageId, offset: anchor ? anchor.getBoundingClientRect().top - top : 0 };
}
function updateLatestButton() {
  const scroller = $('conversation-scroll');
  if (!scroller || !$('jump-latest')) return;
  const away = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 100;
  $('jump-latest').classList.toggle('hidden', !away || !state.items.length);
}
function restoreScroll(previous, forceBottom = false) {
  const scroller = $('conversation-scroll');
  if (!scroller) return;
  if (forceBottom || previous.bottom) scroller.scrollTop = scroller.scrollHeight;
  else {
    const anchor = [...$('timeline').querySelectorAll('[data-message-id]')].find(card => card.dataset.messageId === previous.id);
    if (anchor) scroller.scrollTop += anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - previous.offset;
    else scroller.scrollTop = Math.min(previous.top, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
  }
  updateLatestButton();
}
function scrollLatest() {
  const scroller = $('conversation-scroll');
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
  updateLatestButton();
}
function resizeMessageInput(preserve = true) {
  const input = $('message-input');
  const previous = preserve ? scrollState() : null;
  const height = window.visualViewport?.height || window.innerHeight || 480;
  const maximum = Math.max(44, Math.min(120, Math.floor(height * .25)));
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, maximum)}px`;
  input.style.overflowY = input.scrollHeight > maximum ? 'auto' : 'hidden';
  if (previous) restoreScroll(previous);
}
function updateViewport() {
  cancelAnimationFrame(viewportFrame);
  viewportFrame = requestAnimationFrame(() => {
    const previous = scrollState();
    const height = Math.round(window.visualViewport?.height || window.innerHeight);
    const width = Math.round(window.visualViewport?.width || window.innerWidth);
    if (Math.abs(width - viewportWidth) > 100) viewportBase = height;
    viewportWidth = width; viewportBase = Math.max(viewportBase, height);
    document.documentElement.style.setProperty('--app-height', `${height}px`);
    document.documentElement.classList.toggle('native-insets', !!state.info.insetsHandled);
    const editing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    const keyboardVisible = state.info.platform === 'Android' && typeof state.info.keyboardVisible === 'boolean'
      ? state.info.keyboardVisible : editing && viewportBase - height > 120;
    document.body.classList.toggle('input-focused', editing);
    document.body.classList.toggle('keyboard-open', keyboardVisible);
    resizeMessageInput(false);
    restoreScroll(previous);
  });
}
function matchesFilters(item) {
  return (!state.filter || item.kind === state.filter) && (!state.q || String(item.text ?? item.filename ?? '').toLocaleLowerCase().includes(state.q.toLocaleLowerCase()));
}
function mergeItems(items, changes = []) {
  const result = new Map(items.map(item => [item.id, item]));
  for (const event of changes) {
    if (event.type === 'deleted') result.delete(event.data.id);
    else if (event.type === 'message') {
      if (matchesFilters(event.data)) result.set(event.data.id, event.data);
      else result.delete(event.data.id);
    } else if (event.type === 'changed' && event.data.id && result.has(event.data.id)) {
      const item = result.get(event.data.id);
      if (item.kind === 'file' && item.expires_at <= Date.now()) result.set(item.id, { ...item, expired: true });
    }
  }
  return [...result.values()].sort((a, b) => b.seq - a.seq);
}
function applyLiveEvent(event, options = {}) {
  if (!state.session || destroyed) return;
  for (const load of activeLoads) load.changes.push(event);
  state.items = mergeItems(state.items, [event]);
  renderTimeline(options);
}
function validServer(value) {
  const url = new URL(value.trim());
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('请输入服务器根地址，不要包含路径、账号或参数');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('公网服务器需使用 HTTPS，本地测试可使用 HTTP');
  return url.origin;
}
async function api(path, options = {}) {
  const response = await fetch(`${state.session.server}/api${path}`, {
    ...options, headers: { Authorization: `Bearer ${state.session.token}`, ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
  });
  if (!response.ok) {
    const message = (await response.json().catch(() => ({}))).error || `请求失败 (${response.status})`;
    if (response.status === 401) await logout(false);
    throw new Error(message);
  }
  return options.raw ? response : response.json();
}
async function savePrefs(next) {
  const previous = state.prefs;
  state.prefs = { ...state.prefs, ...next };
  try {
    if (bridge) state.prefs = await bridge.invoke('prefs', state.prefs);
    else localStorage.setItem(`prefs:${state.session.server}:${state.session.username}`, JSON.stringify(state.prefs));
  } catch (e) { state.prefs = previous; toast(e.message); }
  renderSettings();
}
function setConnected(connected, detail) {
  state.connected = connected;
  $('connection').classList.toggle('connected', connected);
  $('connection').querySelector('span').textContent = detail || (connected ? '已连接 · 实时同步' : '连接中断 · 正在重连');
}
function updateConfig() {
  $('max-file').textContent = state.session.config.maxFileMB;
  $('retention-days').textContent = state.session.config.retentionDays;
}
async function enter() {
  destroyed = false; appReady = false;
  $('login-screen').classList.add('hidden'); $('app').classList.remove('hidden');
  $('account-name').textContent = state.session.username;
  $('avatar').textContent = state.session.username[0].toUpperCase();
  $('admin-button').classList.toggle('hidden', state.session.role !== 'admin');
  $('mobile-admin').classList.toggle('hidden', state.session.role !== 'admin');
  if ($('mobile-account-name')) $('mobile-account-name').textContent = state.session.username;
  if ($('account-summary')) $('account-summary').title = state.session.role === 'admin' ? '空间管理员' : '我的同步空间';
  updateConfig(); renderSettings();
  updateViewport(); resizeMessageInput();
  await Promise.all([refresh(false, { reset: true, bottom: true }), loadDevices()]);
  if (bridge) await bridge.invoke('connect', state.session);
  else connectWeb();
  appReady = true;
  if (bridge && state.info.platform !== 'Android') {
    try { for (const task of await bridge.invoke('listDownloads')) updateDownload(task); } catch {}
  }
  if (state.info.platform === 'Android') await receiveShare();
  if (pendingFocusMessage) {
    const id = pendingFocusMessage; pendingFocusMessage = null;
    try { await focusMessage(id); } catch (e) { if (state.session) toast(e.message); }
  }
}
async function login(event) {
  event.preventDefault(); $('login-error').textContent = ''; $('login-button').disabled = true;
  try {
    const server = validServer($('server-input').value);
    const response = await fetch(`${server}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('username-input').value.trim(), password: $('password-input').value, deviceName: $('device-input').value.trim(), deviceKey, platform: state.info.platform }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '登录失败');
    state.session = { ...result, server }; $('password-input').value = '';
    localStorage.setItem('jianjian-server', server); localStorage.setItem('jianjian-name', $('device-input').value.trim());
    if (bridge) {
      await bridge.invoke('saveSession', state.session);
      state.prefs = (await bridge.invoke('getState')).prefs;
    } else {
      sessionStorage.setItem('jianjian-session', JSON.stringify(state.session));
      state.prefs = { ...defaults, ...JSON.parse(localStorage.getItem(`prefs:${server}:${result.username}`) || '{}') };
    }
    await enter();
  } catch (e) { $('login-error').textContent = e.message === 'Failed to fetch' ? '无法连接服务器，请检查地址、网络和 HTTPS 证书' : e.message; }
  finally { $('login-button').disabled = false; }
}
async function logout(revoke = true) {
  for (const task of downloadTasks.values()) task.controller?.abort();
  downloadTasks.clear(); renderDownloads();
  uploadRequest?.abort();
  attachments = []; renderAttachments();
  destroyed = true; appReady = false; pendingFocusMessage = null; eventAbort?.abort(); clearTimeout(reconnectTimer);
  ++refreshGeneration; clearTimeout(searchTimer);
  if (revoke && state.session) await api('/logout', { method: 'POST' }).catch(() => {});
  if (bridge) await bridge.invoke('logout').catch(() => {});
  sessionStorage.removeItem('jianjian-session'); state.session = null; state.items = []; state.nextBefore = null;
  state.filter = ''; state.q = ''; $('search').value = ''; updateTabs();
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  $('app').classList.add('hidden'); $('login-screen').classList.remove('hidden'); $('timeline').replaceChildren();
  setToolsOpen(false); setSearchOpen(false); updateViewport();
}
async function refresh(more = false, options = {}) {
  if (!state.session) return;
  if (more && (loadingMore || !state.nextBefore)) return;
  if (options.reset) ++refreshGeneration;
  const generation = refreshGeneration;
  const before = more ? state.nextBefore : null;
  const oldest = !more && !options.reset && state.items.length ? state.items.at(-1).seq : null;
  const load = { changes: [] }; activeLoads.add(load);
  if (more) { loadingMore = true; $('load-more').disabled = true; }
  $('timeline').setAttribute('aria-busy', 'true');
  try {
    const collected = []; let cursor = before, nextBefore;
    do {
      const query = new URLSearchParams({ kind: state.filter, q: state.q, limit: '50' });
      if (cursor) query.set('before', cursor);
      const result = await api(`/messages?${query}`);
      if (generation !== refreshGeneration || !state.session || destroyed) return;
      collected.push(...result.items); nextBefore = result.nextBefore; cursor = nextBefore;
      // Reconnection reconciles the entire loaded range, including deletions made offline.
      if (more || options.reset || oldest === null || !cursor || collected.at(-1)?.seq <= oldest) break;
    } while (cursor);
    if (generation !== refreshGeneration || !state.session) return;
    if (more) {
      state.items = mergeItems([...state.items, ...collected], load.changes);
      if (state.nextBefore === before) state.nextBefore = nextBefore;
    } else {
      // An older page may finish while reconciliation is in flight; retain that page.
      const boundary = collected.at(-1)?.seq;
      const older = !options.reset && nextBefore && boundary !== undefined ? state.items.filter(item => item.seq < boundary) : [];
      state.items = mergeItems([...older, ...collected], load.changes);
      if (!older.length) state.nextBefore = nextBefore;
    }
    renderTimeline({ bottom: !!options.bottom, preserve: more });
  } finally {
    activeLoads.delete(load);
    if (more) { loadingMore = false; $('load-more').disabled = false; }
    $('timeline').setAttribute('aria-busy', activeLoads.size ? 'true' : 'false');
  }
}
function renderTimeline(options = {}) {
  const previous = scrollState();
  if (options.preserve) previous.bottom = false;
  const list = $('timeline'); list.replaceChildren(); let previousDay = '';
  for (const item of [...state.items].sort((a, b) => a.seq - b.seq)) {
    const date = new Date(item.created_at);
    const day = date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
    if (day !== previousDay) { list.append(element('div', 'date-divider', day)); previousDay = day; }
    const own = item.device_id === state.session.deviceId;
    const card = element('article', `message-card${own ? ' own' : ''}`); card.dataset.messageId = item.id;
    card.append(element('div', 'message-avatar', platformName(item.platform)));
    const content = element('div', 'message-content');
    const meta = element('div', 'message-meta');
    meta.append(element('span', 'device-name', item.device_name), element('span', `kind-label ${item.kind}`, { text: '消息', clipboard: '剪贴板', file: '文件' }[item.kind]));
    if (own) meta.append(element('span', 'local-label', '本机'));
    const time = element('time', '', date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })); time.dateTime = date.toISOString(); meta.append(time); content.append(meta);
    const bubble = element('div', `message-bubble${item.kind === 'file' ? ' file-bubble' : ''}`);
    const footer = element('div', 'card-footer');
    if (item.kind === 'file') {
      const expired = item.expired || item.expires_at <= Date.now();
      const row = element('div', 'file-body');
      const extension = item.filename.includes('.') ? item.filename.split('.').at(-1).slice(0, 4).toUpperCase() : 'FILE';
      row.append(element('div', 'file-symbol', extension));
      const desc = element('div'); desc.append(element('strong', '', item.filename));
      const size = item.size >= 1048576 ? `${(item.size / 1048576).toFixed(1)} MB` : `${(item.size / 1024).toFixed(1)} KB`;
      desc.append(element('small', expired ? 'expired-label' : '', `${size} · ${expired ? '已过期，文件已不可下载' : `${new Date(item.expires_at).toLocaleDateString('zh-CN')} 到期`}`)); row.append(desc); bubble.append(row);
      const download = element('button', '', expired ? '已过期' : '↓ 下载文件'); download.disabled = !!expired;
      download.onclick = () => downloadFile(item, download); footer.append(download);
    } else {
      bubble.append(element('p', 'message-text', item.text));
      const copy = element('button', '', '▢ 复制'); copy.onclick = async () => {
        try { if (bridge) await bridge.invoke('copy', item.text); else await navigator.clipboard.writeText(item.text); toast('已复制'); } catch (e) { toast(`复制失败：${e.message}`); }
      }; footer.append(copy);
    }
    const del = element('button', 'delete-button', '删除');
    del.onclick = async () => {
      if (!await confirmAction('删除这条记录？', '将从所有设备的时间线删除这条记录；文件也会从服务器删除。已下载到本机的文件不会被删除。')) return;
      try { await api(`/messages/${item.id}`, { method: 'DELETE' }); applyLiveEvent({ type: 'deleted', data: { id: item.id } }); } catch (e) { toast(e.message); }
    }; footer.append(del); content.append(bubble, footer); card.append(content); list.append(card);
  }
  $('empty').classList.toggle('hidden', state.items.length !== 0);
  const filtered = !!(state.filter || state.q);
  $('empty').querySelector('h2').textContent = filtered ? '还没有匹配的记录' : '给自己发第一条消息';
  $('empty').querySelector('p').textContent = filtered ? '换个关键词或内容类型再试试。' : '在另一台设备登录同一账号，就能接着看、接着用。';
  $('load-more').classList.toggle('hidden', !state.nextBefore);
  $('total-count').textContent = `${state.items.length}${state.nextBefore ? '+' : ''}`;
  restoreScroll(previous, !!options.bottom);
}
const downloadTasks = new Map();
const activeDownload = task => ['selecting', 'starting', 'downloading', 'saving'].includes(task.status);
function downloadSize(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}
function renderDownloads() {
  const host = $('download-tasks'); if (!host) return;
  host.replaceChildren(); host.classList.toggle('hidden', !downloadTasks.size);
  for (const task of downloadTasks.values()) {
    const row = element('div', 'download-task');
    const heading = element('div', 'download-heading'); heading.append(element('strong', '', task.filename));
    const action = element('button', '', activeDownload(task) ? '取消' : '关闭'); action.type = 'button';
    action.disabled = task.status === 'selecting' || task.status === 'saving';
    action.onclick = async () => {
      if (activeDownload(task)) {
        if (task.controller) task.controller.abort();
        else { try { await bridge.invoke('cancelDownload', { id: task.id }); } catch (e) { toast(e.message); } }
      } else { downloadTasks.delete(task.id); renderDownloads(); }
    };
    heading.append(action); row.append(heading);
    const labels = { selecting: '请选择保存位置', starting: '正在连接，等待服务器响应…', downloading: '正在下载', saving: '正在保存文件…', completed: '已保存', handedOff: '已交给浏览器保存，请查看浏览器下载列表', failed: '下载失败', canceled: '已取消' };
    const percent = task.total > 0 ? `${Math.min(100, Math.floor(task.loaded / task.total * 100))}% · ` : '';
    const detail = task.status === 'downloading' ? `${percent}${downloadSize(task.loaded)}${task.total ? ' / ' + downloadSize(task.total) : ''}${task.speed > 0 ? ' · ' + downloadSize(task.speed) + '/s' : ''}` : '';
    row.append(element('small', '', `${labels[task.status] || task.status}${detail ? ' · ' + detail : ''}${task.error && task.status === 'failed' ? '：' + task.error : ''}${task.path ? '：' + task.path : ''}`));
    if (['starting', 'downloading', 'saving'].includes(task.status)) {
      const progress = element('progress'); progress.max = task.total || 1;
      if (task.total && task.status === 'downloading') progress.value = task.loaded;
      progress.setAttribute('aria-label', `${task.filename} 下载进度`); row.append(progress);
    }
    host.append(row);
  }
}
function updateDownload(task) {
  downloadTasks.set(task.id, { ...downloadTasks.get(task.id), ...task });
  for (const [id, value] of downloadTasks) if (downloadTasks.size > 20 && !activeDownload(value)) downloadTasks.delete(id);
  renderDownloads();
}
async function downloadFile(item, button) {
  if (!state.session) return;
  if ([...downloadTasks.values()].some(task => task.fileId === item.id && activeDownload(task))) return toast('该文件正在下载，请查看下方进度');
  const session = state.session, id = crypto.randomUUID();
  const task = { id, fileId: item.id, filename: item.filename, status: 'selecting', loaded: 0, total: item.size || 0, speed: 0 };
  updateDownload(task); button.disabled = true;
  let writer, reader;
  const active = () => state.session === session && !destroyed;
  const publish = (status, extra = {}) => { Object.assign(task, extra, { status }); if (active()) updateDownload(task); };
  try {
    if (bridge) {
      const result = await bridge.invoke('download', { id: item.id, filename: item.filename });
      downloadTasks.delete(id);
      if (active() && state.info.platform === 'Android') toast('已交给系统下载，请查看通知栏进度');
      // Desktop progress is delivered by the native host, including cancellation and completion.
      renderDownloads(); return;
    }
    const controller = new AbortController(); task.controller = controller;
    let handle;
    if (typeof window.showSaveFilePicker === 'function') handle = await window.showSaveFilePicker({ suggestedName: item.filename });
    if (!active()) return;
    publish('starting');
    if (handle) writer = await handle.createWritable();
    const response = await api(`/files/${item.id}`, { raw: true, signal: controller.signal });
    if (!active() || controller.signal.aborted) throw new DOMException('已取消', 'AbortError');
    const length = Number(response.headers.get('content-length')); if (Number.isFinite(length) && length > 0) task.total = length;
    reader = response.body.getReader();
    const chunks = []; let last = Date.now(), lastBytes = 0;
    publish('downloading');
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      if (!active() || controller.signal.aborted) throw new DOMException('已取消', 'AbortError');
      if (writer) await writer.write(value); else chunks.push(value);
      task.loaded += value.byteLength;
      const now = Date.now(); if (now - last >= 250) {
        task.speed = (task.loaded - lastBytes) * 1000 / Math.max(1, now - last); last = now; lastBytes = task.loaded; publish('downloading');
      }
    }
    if (!active() || controller.signal.aborted) throw new DOMException('已取消', 'AbortError');
    if (task.total && task.loaded !== task.total) throw new Error('文件传输不完整，请重试');
    publish('saving');
    if (writer) { await writer.close(); writer = null; publish('completed', { speed: 0 }); }
    else {
      const url = URL.createObjectURL(new Blob(chunks)); const link = element('a'); link.href = url; link.download = item.filename;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
      publish('handedOff', { speed: 0 });
    }
  } catch (e) {
    if (writer) await writer.abort().catch(() => {});
    publish(e.name === 'AbortError' || task.controller?.signal.aborted ? 'canceled' : 'failed', { error: e.message, speed: 0 });
  } finally {
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (!active()) downloadTasks.delete(id);
    button.disabled = false;
  }
}

async function send(text, kind = 'text') {
  if (!text.trim()) return;
  const item = await api('/messages', { method: 'POST', body: JSON.stringify({ text, kind, clientId: crypto.randomUUID() }) });
  if (!state.session) return;
  if (state.filter || state.q) {
    clearTimeout(searchTimer); state.filter = ''; state.q = ''; $('search').value = ''; updateTabs(); setSearchOpen(false);
    await refresh(false, { reset: true, bottom: true });
  } else applyLiveEvent({ type: 'message', data: item }, { bottom: true });
}
function renderAttachments() {
  const host = $('pending-attachments'); host.replaceChildren();
  for (const file of attachments) {
    const row = element('div', 'pending-file');
    row.append(element('span', '', `${file.name} (${Math.ceil(file.size / 1024)} KB)`));
    const remove = element('button', '', '移除'); remove.type = 'button';
    remove.onclick = () => { attachments = attachments.filter(item => item !== file); renderAttachments(); };
    row.append(remove); host.append(row);
  }
}
function addAttachments(files) {
  for (const file of files) {
    if (attachments.length >= 20) { toast('一次最多添加 20 个附件'); break; }
    if (state.session && file.size > state.session.config.maxFileMB * 1048576) { toast(`${file.name} 超过大小限制`); continue; }
    attachments.push(file);
  }
  renderAttachments();
}
async function receiveShare() {
  try {
    const share = await bridge.invoke('takeShare'); if (!share) return;
    if (share.text) { $('message-input').value += ($('message-input').value ? '\n' : '') + share.text; resizeMessageInput(); }
    for (const file of share.files || []) {
      const response = await fetch(file.url); if (!response.ok) throw new Error('无法读取分享文件');
      addAttachments([new File([await response.blob()], file.name, { type: file.mime })]);
    }
    toast('分享内容已添加，请确认后发送');
  } catch (e) { toast(e.message); }
}
async function compose(event) {
  event.preventDefault(); const value = $('message-input').value; if (!value.trim() && !attachments.length) return;
  if (sending || composing || event.isComposing) return;
  sending = true; $('send-button').disabled = true;
  try { if (value.trim()) await send(value); if (attachments.length) await sendFiles([...attachments], true); if ($('message-input').value === value) $('message-input').value = ''; resizeMessageInput(); }
  catch (e) { toast(e.message === 'Failed to fetch' ? '当前离线，文字已保留，请连接后重试' : e.message); }
  finally { sending = false; $('send-button').disabled = false; }
}
async function sendFiles(files, staged = false) {
  if (!state.session || !files.length) return;
  if (uploadBusy) return toast('正在上传文件，请稍候');
  const uploadSession = state.session;
  uploadBusy = true; $('attach-button').disabled = true; $('upload-status').classList.remove('hidden');
  try {
    for (const file of files) {
      if (state.session !== uploadSession || destroyed) break;
      if (file.size > state.session.config.maxFileMB * 1048576) { toast(`${file.name} 超过 ${state.session.config.maxFileMB} MB 限制`); continue; }
      const uploaded = await new Promise((resolve, reject) => {
        const request = new XMLHttpRequest(); uploadRequest = request; request.onabort = () => reject(new Error('上传已取消')); request.open('POST', `${state.session.server}/api/files`);
        request.setRequestHeader('Authorization', `Bearer ${state.session.token}`);
        request.setRequestHeader('Content-Type', 'application/octet-stream'); request.setRequestHeader('X-Filename', encodeURIComponent(file.name)); request.setRequestHeader('X-Client-Id', crypto.randomUUID());
        request.upload.onprogress = event => { $('upload-status').textContent = `正在上传 ${file.name} · ${event.lengthComputable ? Math.round(event.loaded / event.total * 100) + '%' : '…'}`; };
        request.onload = () => { if (request.status >= 200 && request.status < 300) { try { resolve(JSON.parse(request.responseText)); } catch { reject(new Error('服务器返回的文件信息无效')); } } else { let error = '上传失败'; try { error = JSON.parse(request.responseText).error || error; } catch {} reject(new Error(error)); } };
        request.onerror = () => reject(new Error('上传中断，请检查连接后重试')); request.timeout = 30 * 60 * 1000; request.ontimeout = () => reject(new Error('文件上传超时，请重试'));
        $('upload-status').textContent = `正在上传 ${file.name}`; request.send(file);
      });
      if (state.session !== uploadSession || destroyed) break;
      if (state.filter || state.q) {
        clearTimeout(searchTimer); state.filter = ''; state.q = ''; $('search').value = ''; updateTabs(); setSearchOpen(false);
        await refresh(false, { reset: true, bottom: true });
      } else applyLiveEvent({ type: 'message', data: uploaded }, { bottom: true });
      if (staged) { attachments = attachments.filter(item => item !== file); renderAttachments(); }
      toast(`${file.name} 已发送`);
    }
  } catch (e) { toast(e.message); }
  finally { uploadRequest = null; uploadBusy = false; $('attach-button').disabled = false; $('upload-status').classList.add('hidden'); $('file-input').value = ''; }
}
async function loadDevices() {
  const session = state.session;
  const devices = await api('/devices');
  if (!state.session || state.session !== session || destroyed) return;
  state.devices = devices; $('device-count').textContent = state.devices.length;
  if ($('chat-device-count')) $('chat-device-count').textContent = `${state.devices.length} 台设备`;
  const current = state.devices.find(d => d.id === state.session.deviceId);
  $('current-device').textContent = current?.name || state.info.name;
  if ($('dialog-device-name')) $('dialog-device-name').textContent = current?.name || state.info.name;
  $('sidebar-devices').replaceChildren(); $('devices-list').replaceChildren();
  for (const device of state.devices) {
    const online = Date.now() - device.last_seen < 65000;
    for (const [target, css] of [[$('sidebar-devices'), 'device-mini'], [$('devices-list'), 'device-row']]) {
      const row = element('div', css); row.append(element('span', 'device-symbol', platformIcon(device.platform)));
      const desc = element('div'); desc.append(element('strong', '', device.name));
      desc.append(element('small', '', `${device.platform} · ${device.id === state.session.deviceId ? '本机' : online ? '最近在线' : new Date(device.last_seen).toLocaleDateString('zh-CN') + ' 活跃'}`)); row.append(desc, element('span', `online-dot ${online ? 'live' : ''}`)); target.append(row);
    }
  }
  $('rename-device').value = current?.name || state.info.name;
}
function renderSettings() {
  $('floating-window-button')?.classList.toggle('hidden', !bridge || state.info.floatingWindow !== true);
  $('auto-send').checked = state.prefs.autoSend; $('auto-write').checked = state.prefs.autoWrite;
  $('auto-start').checked = state.prefs.autoStart; $('background').checked = state.prefs.background;
  $('auto-send').disabled = !state.info.clipboard || state.info.autoSendSupported === false; $('auto-write').disabled = !state.info.clipboard;
  $('startup-row').classList.toggle('hidden', !bridge || state.info.platform === 'Android');
  $('background-row').classList.toggle('hidden', state.info.platform !== 'Android');
  $('capability').textContent = state.info.capability || '网页版仅支持手动复制和发送。自动剪贴板同步请使用剪剪客户端。';
  $('sync-summary').replaceChildren(element('span', '', `自动发送 ${state.prefs.autoSend ? '已开启' : '已关闭'}`), element('span', '', `自动写入 ${state.prefs.autoWrite ? '已开启' : '已关闭'}`), element('span', '', state.info.platform === 'Android' ? '后台读取剪贴板受系统限制' : '设置仅对本机生效'));
}
async function handleEvent(event) {
  if (event.type === 'download') { if (state.session && !destroyed) updateDownload(event.data); return; }
  if (event.type === 'share') { if (appReady && state.session) await receiveShare(); return; }
  if (event.type === 'viewport') {
    if (typeof event.keyboardVisible === 'boolean') state.info.keyboardVisible = event.keyboardVisible;
    updateViewport(); return;
  }
  if (event.type === 'focusMessage' && typeof event.id === 'string' && event.id) {
    if (destroyed) return;
    if (!appReady) pendingFocusMessage = event.id;
    else { try { await focusMessage(event.id); } catch (e) { if (state.session) toast(e.message); } }
    return;
  }
  if (!state.session || destroyed) return;
  if (event.type === 'status') { setConnected(event.connected, event.detail); return; }
  if (event.type === 'error') { toast(event.message); return; }
  if (event.type === 'auth') { await logout(false); toast('登录已失效，请重新登录'); return; }
  if (event.type === 'message' && event.data?.id) {
    applyLiveEvent(event);
    loadDevices().catch(() => {});
    return;
  }
  if (event.type === 'deleted' && event.data?.id) { applyLiveEvent(event); return; }
  if (event.type === 'changed' && event.data?.id) { applyLiveEvent(event); return; }
  if (event.type === 'ready' || event.type === 'changed') {
    if (event.type === 'ready') setConnected(true);
    try { await Promise.all([refresh(), loadDevices()]); } catch (e) { if (state.session) toast(e.message); }
  }
}
async function connectWeb() {
  eventAbort?.abort(); eventAbort = new AbortController(); const controller = eventAbort;
  try {
    const response = await fetch(`${state.session.server}/api/events`, { headers: { Authorization: `Bearer ${state.session.token}` }, signal: controller.signal });
    if (response.status === 401) { await logout(false); return; }
    if (!response.ok) throw new Error('连接失败');
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        const type = /^event: (.+)$/m.exec(block)?.[1]; const data = /^data: (.+)$/m.exec(block)?.[1];
        if (type) handleEvent({ type, data: data ? JSON.parse(data) : {} });
      }
    }
  } catch (e) { if (controller.signal.aborted) return; }
  if (controller.signal.aborted || !state.session || destroyed) return;
  setConnected(false); reconnectTimer = setTimeout(connectWeb, 3000);
}
function updateTabs() { document.querySelectorAll('[data-filter]').forEach(b => { const active = b.dataset.filter === state.filter; b.classList.toggle('active', active); b.setAttribute('aria-selected', active); }); }
function setToolsOpen(open) {
  const previous = scrollState();
  $('composer-tools')?.classList.toggle('hidden', !open);
  $('tools-toggle')?.setAttribute('aria-expanded', String(open));
  restoreScroll(previous);
}
function setSearchOpen(open) {
  const previous = scrollState();
  $('search-panel')?.classList.toggle('hidden', !open);
  $('search-toggle')?.setAttribute('aria-expanded', String(open));
  restoreScroll(previous);
}
function closeSearch() {
  clearTimeout(searchTimer); setSearchOpen(false);
  const hadSearch = !!state.q;
  state.q = ''; $('search').value = '';
  if (hadSearch && state.session) refresh(false, { reset: true, bottom: true }).catch(e => toast(e.message));
}
function openSettings() {
  renderSettings(); $('settings-dialog').showModal();
}
async function openDevices() {
  $('settings-dialog').close(); $('devices-dialog').showModal();
  await loadDevices().catch(e => toast(e.message));
}
function openTimeline() {
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  clearTimeout(searchTimer); setSearchOpen(false); setToolsOpen(false);
  state.filter = ''; state.q = ''; $('search').value = ''; updateTabs();
  refresh(false, { reset: true, bottom: true }).catch(e => toast(e.message));
}
function focusTimelineCard(id) {
  const card = [...$('timeline').querySelectorAll('[data-message-id]')].find(item => item.dataset.messageId === id);
  if (!card) return false;
  card.scrollIntoView({ block: 'center', behavior: 'auto' });
  card.tabIndex = -1; card.focus({ preventScroll: true });
  card.classList.add('focused-message');
  setTimeout(() => card.classList.remove('focused-message'), 3200);
  updateLatestButton();
  return true;
}
async function focusMessage(id) {
  if (!state.session) return;
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  clearTimeout(searchTimer); setSearchOpen(false); setToolsOpen(false);
  state.filter = ''; state.q = ''; $('search').value = ''; updateTabs();
  let loading = refresh(false, { reset: true, bottom: true });
  let generation = refreshGeneration;
  await loading;
  if (generation !== refreshGeneration || !state.session || destroyed) return;
  if (focusTimelineCard(id)) return;
  // The compact window may retain a file older than the latest mixed page.
  // Limit lookup to one file page; never walk a user's entire history here.
  state.filter = 'file'; updateTabs();
  loading = refresh(false, { reset: true, bottom: true });
  generation = refreshGeneration;
  await loading;
  if (generation !== refreshGeneration || !state.session || destroyed) return;
  if (!focusTimelineCard(id)) toast('已打开文件列表，可搜索文件名或加载更早的记录。文件也可能已被删除。');
}
window.__handleNativeBack = () => {
  const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
  if (dialog) {
    if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close();
    return true;
  }
  if ($('composer-tools') && !$('composer-tools').classList.contains('hidden')) { setToolsOpen(false); return true; }
  if ($('search-panel') && !$('search-panel').classList.contains('hidden')) { closeSearch(); return true; }
  return false;
};
function confirmAction(title, text) {
  $('confirm-title').textContent = title; $('confirm-text').textContent = text; $('confirm-dialog').showModal();
  return new Promise(resolve => {
    const done = result => { $('confirm-dialog').close(); $('confirm-dialog').oncancel = null; resolve(result); };
    $('confirm-cancel').onclick = () => done(false); $('confirm-ok').onclick = () => done(true); $('confirm-dialog').oncancel = () => done(false);
  });
}
async function showAdmin() {
  $('settings-dialog').close(); $('admin-dialog').showModal();
  try {
    const users = await api('/admin/users'); $('users-list').replaceChildren();
    for (const user of users) {
      const row = element('div', 'user-row'); const label = element('div'); label.append(element('strong', '', user.username), element('small', '', `${user.role === 'admin' ? '管理员' : '用户'} · ${user.devices} 台设备 · ${user.enabled ? '已启用' : '已停用'}`)); row.append(label);
      if (user.username !== state.session.username) {
        const button = element('button', user.enabled ? 'danger-button' : 'secondary', user.enabled ? '停用账号' : '启用账号');
        button.onclick = async () => { try { await api(`/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !user.enabled }) }); await showAdmin(); } catch (e) { toast(e.message); } }; row.append(button);
      }
      $('users-list').append(row);
    }
    $('config-max').value = state.session.config.maxFileMB; $('config-days').value = state.session.config.retentionDays; $('config-quota').value = state.session.config.userQuotaMB;
  } catch (e) { toast(e.message); }
}
$('login-form').onsubmit = login; $('compose').onsubmit = compose;
$('message-input').onkeydown = event => { if (!event.isComposing && event.keyCode !== 229 && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (!sending) $('compose').requestSubmit(); } };
$('message-input').oninput = resizeMessageInput;
$('message-input').oncompositionstart = () => { composing = true; };
$('message-input').oncompositionend = () => { composing = false; resizeMessageInput(); };
$('attach-button').onclick = () => $('file-input').click(); $('file-input').onchange = () => { addAttachments([...$('file-input').files]); $('file-input').value = ''; };
$('paste-button').onclick = async () => { if ($('paste-button').disabled) return; $('paste-button').disabled = true; try { const text = bridge ? await bridge.invoke('readClipboard') : await navigator.clipboard.readText(); if (!text?.trim()) return toast('剪贴板中没有文字'); await send(text, 'clipboard'); toast('剪贴板已发送'); } catch (e) { toast(e.message); } finally { $('paste-button').disabled = false; } };
$('settings-button').onclick = $('mobile-settings').onclick = openSettings;
if ($('floating-window-button')) $('floating-window-button').onclick = async () => {
  if (!bridge || state.info.floatingWindow !== true) return;
  try { await bridge.invoke('showFloating'); } catch (e) { toast(e.message); }
};
if ($('mobile-settings-nav')) $('mobile-settings-nav').onclick = openSettings;
$('devices-nav').onclick = $('mobile-devices').onclick = openDevices;
$('timeline-nav').onclick = openTimeline;
if ($('mobile-timeline')) $('mobile-timeline').onclick = openTimeline;
if ($('jump-latest')) $('jump-latest').onclick = scrollLatest;
if ($('conversation-scroll')) $('conversation-scroll').addEventListener('scroll', updateLatestButton, { passive: true });
if ($('search-toggle')) $('search-toggle').onclick = () => {
  const open = $('search-panel').classList.contains('hidden');
  if (open) { setSearchOpen(true); $('search').focus(); } else closeSearch();
};
if ($('tools-toggle')) $('tools-toggle').onclick = () => setToolsOpen($('composer-tools').classList.contains('hidden'));
$('admin-button').onclick = $('mobile-admin').onclick = showAdmin;
$('logout-button').onclick = $('mobile-logout').onclick = () => logout();
document.querySelectorAll('.close-dialog').forEach(b => b.onclick = () => b.closest('dialog').close());
document.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { clearTimeout(searchTimer); state.filter = b.dataset.filter; state.q = $('search').value.slice(0, 200); updateTabs(); refresh(false, { reset: true, bottom: true }).catch(e => toast(e.message)); });
$('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.q = $('search').value.slice(0, 200); refresh(false, { reset: true, bottom: true }).catch(e => toast(e.message)); }, 300); };
$('search').onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); closeSearch(); $('search-toggle')?.focus(); } };
$('load-more').onclick = async () => { try { await refresh(true); } catch (e) { toast(e.message); } };
for (const [id, key] of [['auto-send', 'autoSend'], ['auto-write', 'autoWrite'], ['auto-start', 'autoStart'], ['background', 'background']]) $(id).onchange = () => savePrefs({ [key]: $(id).checked });
$('save-device').onclick = async () => { try { await api(`/devices/${state.session.deviceId}`, { method: 'PATCH', body: JSON.stringify({ name: $('rename-device').value }) }); localStorage.setItem('jianjian-name', $('rename-device').value); await loadDevices(); toast('设备名称已保存'); } catch (e) { toast(e.message); } };
$('create-user-form').onsubmit = async event => { event.preventDefault(); try { await api('/admin/users', { method: 'POST', body: JSON.stringify({ username: $('new-username').value.trim(), password: $('new-password').value }) }); $('create-user-form').reset(); await showAdmin(); toast('账号已创建'); } catch (e) { toast(e.message); } };
$('config-form').onsubmit = async event => { event.preventDefault(); try { state.session.config = await api('/admin/config', { method: 'PATCH', body: JSON.stringify({ maxFileMB: Number($('config-max').value), retentionDays: Number($('config-days').value), userQuotaMB: Number($('config-quota').value) }) }); updateConfig(); toast('文件策略已保存'); } catch (e) { toast(e.message); } };
let dragDepth = 0;
window.addEventListener('dragenter', e => { if (!state.session || !e.dataTransfer.types.includes('Files')) return; e.preventDefault(); dragDepth++; $('drop-overlay').classList.remove('hidden'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').classList.add('hidden'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('drop-overlay').classList.add('hidden'); if (state.session && e.dataTransfer.files.length) addAttachments([...e.dataTransfer.files]); });
window.addEventListener('online', () => { if (state.session && !bridge) connectWeb(); });
window.addEventListener('resize', updateViewport, { passive: true });
window.visualViewport?.addEventListener('resize', updateViewport, { passive: true });
window.addEventListener('focusin', updateViewport);
window.addEventListener('focusout', updateViewport);
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  if (window.__handleNativeBack()) event.preventDefault();
});
async function boot() {
  try {
    if (bridge) {
      bridge.onEvent(handleEvent);
      const initial = await bridge.invoke('getState'); state.info = initial.info; state.prefs = { ...defaults, ...initial.prefs }; state.session = initial.session;
    } else state.session = JSON.parse(sessionStorage.getItem('jianjian-session') || 'null');
    $('server-input').value = localStorage.getItem('jianjian-server') || (location.protocol.startsWith('http') && !location.hostname.includes('androidplatform') ? location.origin : '');
    $('device-input').value = localStorage.getItem('jianjian-name') || state.info.name;
    updateViewport();
    if (state.session) {
      try { const me = await api('/me'); if (state.session) { Object.assign(state.session, me); await enter(); } }
      catch (e) {
        if (state.session) { $('login-error').textContent = '服务器暂时不可达，请检查网络后重试登录'; }
      }
    }
  } catch (e) { $('login-error').textContent = e.message; }
}

$('message-input').addEventListener('paste', event => {
  const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
  if (files.length) { event.preventDefault(); addAttachments(files); }
});

boot();
