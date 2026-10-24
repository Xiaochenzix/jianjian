/* This window shares the desktop session and sync engine through a restricted bridge. */
'use strict';
const $ = id => document.getElementById(id);
const bridge = window.jianjian;
const state = { session: null, info: {}, connected: false, items: [], loaded: false };
const loads = new Set();
let sessionGeneration = 0, refreshGeneration = 0, stateGeneration = 0;
let sending = false, composing = false, retryDraft = null, noticeTimer, unread = 0, pendingState = null;

function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}
function notify(message) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message; $('notice').hidden = false;
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 4500);
}
function updateStatus() {
  $('connection').classList.toggle('connected', !!state.session && state.connected);
  $('connection-text').textContent = !state.session ? '请先登录' : state.connected ? '已连接 · 实时同步' : '已断线 · 自动重连中';
  $('connection').title = state.session ? `${state.session.username} · ${state.info.name || '本机'}` : '';
  $('login-state').hidden = !!state.session; $('chat').hidden = !state.session;
  $('message-input').disabled = !state.session;
  updateSendButton();
}
function updateSendButton() {
  $('send-button').disabled = !state.session || sending || !$('message-input').value.trim();
  $('send-button').textContent = sending ? '发送中' : '发送';
}
function scrollState() {
  const scroller = $('scroller');
  const top = scroller.getBoundingClientRect().top;
  const anchor = [...$('timeline').children].find(item => item.dataset.messageId && item.getBoundingClientRect().bottom > top + 1);
  return { bottom: scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop < 36, top: scroller.scrollTop, id: anchor?.dataset.messageId, offset: anchor ? anchor.getBoundingClientRect().top - top : 0 };
}
function updateLatestButton() {
  const scroller = $('scroller');
  const away = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > 45;
  if (!away) unread = 0;
  $('latest-button').hidden = !away || !state.items.length;
  $('latest-button').textContent = unread ? `↓ ${unread} 条新消息` : '↓ 最新消息';
}
function restoreScroll(previous, bottom = false) {
  const scroller = $('scroller');
  if (bottom || previous.bottom) { scroller.scrollTop = scroller.scrollHeight; unread = 0; }
  else {
    const anchor = [...$('timeline').children].find(item => item.dataset.messageId === previous.id);
    scroller.scrollTop = anchor
      ? scroller.scrollTop + anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - previous.offset
      : Math.min(previous.top, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
  }
  updateLatestButton();
}
function mergeItems(items, changes = []) {
  const result = new Map(items.filter(item => item?.id).map(item => [item.id, item]));
  for (const event of changes) {
    if (event.type === 'delete' || event.type === 'deleted') result.delete(event.data?.id);
    else if (event.type === 'message' && event.data?.id) result.set(event.data.id, event.data);
    else if (event.type === 'changed' && result.has(event.data?.id)) {
      const item = result.get(event.data.id);
      if (item.kind === 'file' && item.expires_at <= Date.now()) result.set(item.id, { ...item, expired: true });
    }
  }
  return [...result.values()].sort((a, b) => a.seq - b.seq).slice(-50);
}
function applyEvent(event, options = {}) {
  if (!state.session) return;
  for (const load of loads) load.changes.push(event);
  const isNew = event.type === 'message' && !state.items.some(item => item.id === event.data?.id);
  if (isNew && !scrollState().bottom) unread++;
  state.items = mergeItems(state.items, [event]);
  render(options);
}
function render(options = {}) {
  const previous = scrollState();
  const timeline = $('timeline'); timeline.replaceChildren(); let previousDay = '';
  for (const item of state.items) {
    const date = new Date(item.created_at);
    const day = date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
    if (day !== previousDay) { timeline.append(node('div', 'day-label', day)); previousDay = day; }
    const own = item.device_id === state.session?.deviceId;
    const article = node('article', `message${own ? ' own' : ''}`); article.dataset.messageId = item.id;
    const meta = node('div', 'message-meta');
    const name = node('span', 'device-name', `${item.device_name || '未命名设备'}${own ? ' · 本机' : ''}`); name.title = `${item.device_name || '未命名设备'} · ${item.platform || '设备'}`;
    const time = node('time', '', date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
    time.dateTime = date.toISOString(); time.title = date.toLocaleString('zh-CN'); meta.append(name, time); article.append(meta);
    if (item.kind === 'file') {
      const file = node('button', 'message-body file-button'); file.type = 'button'; file.title = '在主界面查看文件';
      const extension = String(item.filename || '').split('.').at(-1).slice(0, 4).toUpperCase();
      file.append(node('span', 'file-icon', extension || 'FILE'));
      const desc = node('span', 'file-description'); desc.append(node('strong', 'file-name', item.filename || '文件'));
      const expired = item.expired || item.expires_at <= Date.now();
      desc.append(node('small', '', expired ? '已过期 · 在主界面查看' : '文件 · 在主界面打开')); file.append(desc);
      file.onclick = () => openMain(item.id); article.append(file);
    } else {
      const body = node('div', 'message-body'); body.append(node('p', 'message-text', item.text || '')); article.append(body);
      const actions = node('div', 'message-actions');
      if (item.kind === 'clipboard') actions.append(node('span', 'kind-label', '剪贴板'));
      const copy = node('button', 'copy-button', '复制'); copy.type = 'button'; copy.setAttribute('aria-label', `复制来自 ${item.device_name || '设备'} 的文字`);
      copy.onclick = async () => {
        try { await bridge.invoke('copy', item.text || ''); notify('已复制到剪贴板'); }
        catch (error) { notify(`复制失败：${error.message}`); }
      };
      actions.append(copy); article.append(actions);
    }
    timeline.append(article);
  }
  $('empty-state').hidden = !!state.items.length;
  if (state.items.length || state.loaded) {
    $('empty-title').textContent = '给自己发第一条消息';
    $('empty-description').textContent = '在其他设备登录同一账号，就能实时接着看。';
    $('retry-load').hidden = true;
  }
  restoreScroll(previous, !!options.bottom);
}
async function refresh(options = {}) {
  if (!state.session) return;
  const generation = ++refreshGeneration, session = sessionGeneration;
  const load = { changes: [] }; loads.add(load); $('timeline').setAttribute('aria-busy', 'true');
  try {
    const result = await bridge.invoke('floatingList');
    if (generation !== refreshGeneration || session !== sessionGeneration || !state.session) return;
    const first = !state.loaded;
    state.items = mergeItems(result.items || [], load.changes); state.loaded = true;
    render({ bottom: first || !!options.bottom });
  } catch (error) {
    if (generation !== refreshGeneration || session !== sessionGeneration || !state.session) return;
    if (!state.items.length) {
      $('empty-title').textContent = '暂时无法获取消息';
      $('empty-description').textContent = '恢复连接后会自动同步，也可以手动重试。';
      $('retry-load').hidden = false;
    }
    notify(error.message || '加载失败，请稍后重试');
  } finally {
    loads.delete(load); $('timeline').setAttribute('aria-busy', String(loads.size > 0));
  }
}
function clearSession() {
  sessionGeneration++; refreshGeneration++; loads.clear();
  pendingState = null;
  state.session = null; state.connected = false; state.items = []; state.loaded = false;
  sending = false; retryDraft = null; composing = false; unread = 0;
  $('message-input').value = ''; $('timeline').replaceChildren(); $('notice').hidden = true;
  $('latest-button').hidden = true; $('empty-state').hidden = false;
  $('empty-title').textContent = '正在获取消息'; $('empty-description').textContent = '消息与剪贴板，随时在这里接着用。';
  $('retry-load').hidden = true; updateStatus();
}
async function loadSession() {
  const generation = ++stateGeneration;
  clearSession();
  const request = { connected: null }; pendingState = request;
  try {
    const result = await bridge.invoke('floatingState');
    if (generation !== stateGeneration) return;
    state.session = result.session; state.info = result.info || {};
    // Status events received after the request began are newer than its snapshot.
    state.connected = request.connected ?? !!result.connected;
    updateStatus(); if (state.session) await refresh({ bottom: true });
  } catch (error) { if (generation === stateGeneration) notify(error.message || '无法读取桌面客户端状态'); }
  finally { if (pendingState === request) pendingState = null; }
}
async function send(event) {
  event?.preventDefault();
  const text = $('message-input').value;
  if (!state.session || sending || composing || event?.isComposing || !text.trim()) return;
  const session = sessionGeneration;
  const draft = retryDraft?.text === text ? retryDraft : { text, clientId: crypto.randomUUID() };
  retryDraft = draft; sending = true; updateSendButton();
  try {
    const item = await bridge.invoke('floatingSend', draft);
    if (session !== sessionGeneration || !state.session) return;
    retryDraft = null;
    if ($('message-input').value === text) $('message-input').value = '';
    applyEvent({ type: 'message', data: item }, { bottom: true });
  } catch (error) {
    if (session === sessionGeneration && state.session) notify(`发送失败，文字已保留。${error.message || '请连接后重试'}`);
  } finally {
    if (session === sessionGeneration) { sending = false; updateSendButton(); }
  }
}
async function openMain(messageId) {
  try { await bridge.invoke('showMain', messageId ? { messageId } : {}); }
  catch (error) { notify(error.message); }
}
async function handleEvent(event) {
  if (event.type === 'session') { await loadSession(); return; }
  if (event.type === 'auth') { stateGeneration++; clearSession(); notify('登录已失效，请在主界面重新登录'); return; }
  if (!state.session) {
    if (pendingState && (event.type === 'status' || event.type === 'ready')) pendingState.connected = event.type === 'ready' || !!event.connected;
    return;
  }
  if (event.type === 'status' || event.type === 'ready') {
    const reconnect = !state.connected && (event.type === 'ready' || event.connected);
    state.connected = event.type === 'ready' || !!event.connected; updateStatus();
    if (reconnect) await refresh();
  } else if (['message', 'delete', 'deleted'].includes(event.type) && event.data?.id) applyEvent(event);
  else if (event.type === 'changed') { if (event.data?.id) applyEvent(event); else await refresh(); }
  else if (event.type === 'error') notify(event.message || '同步暂时出现问题');
}
$('open-main').onclick = $('login-button').onclick = () => openMain();
$('hide-window').onclick = async () => { try { await bridge.invoke('floatingHide'); } catch (error) { notify(error.message); } };
$('compose').onsubmit = send;
$('message-input').oninput = updateSendButton;
$('message-input').oncompositionstart = () => { composing = true; };
$('message-input').oncompositionend = () => { composing = false; updateSendButton(); };
$('message-input').onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) {
    event.preventDefault(); send(event);
  }
};
$('scroller').addEventListener('scroll', updateLatestButton, { passive: true });
$('latest-button').onclick = () => { $('scroller').scrollTop = $('scroller').scrollHeight; updateLatestButton(); };
$('retry-load').onclick = () => refresh();
window.addEventListener('resize', updateLatestButton);
async function boot() {
  if (!bridge) { clearSession(); notify('请从 Windows 剪剪客户端打开悬浮窗'); return; }
  bridge.onEvent(handleEvent); await loadSession();
}
boot();
