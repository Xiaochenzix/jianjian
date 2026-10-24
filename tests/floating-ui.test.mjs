import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const source = readFileSync(new URL('../desktop/floating.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../desktop/floating.html', import.meta.url), 'utf8');

// Run the actual renderer with a small DOM/IPC harness, including its event and request races.
function harness() {
  const elements = new Map();
  class Element {
    constructor(tag, id = '') {
      this.tagName = tag.toUpperCase(); this.id = id; this.children = []; this.dataset = {};
      this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false;
      this.style = {}; this.listeners = new Map(); this.attrs = new Map(); this._scrollTop = 0;
      const classes = new Set();
      this.classList = { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }, contains(name) { return classes.has(name); } };
    }
    append(...items) { for (const item of items) { item.parentElement = this; this.children.push(item); } }
    replaceChildren(...items) { this.children = []; this.append(...items); }
    setAttribute(name, value) { this.attrs.set(name, String(value)); }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    get clientHeight() { return this.id === 'scroller' ? 200 : 0; }
    get scrollHeight() { return this.id === 'scroller' ? elements.get('timeline').children.reduce((height, item) => height + (item.dataset.messageId ? 80 : 20), 0) : 0; }
    get scrollTop() { return this._scrollTop; }
    set scrollTop(value) { this._scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); }
    getBoundingClientRect() {
      if (this.parentElement?.id === 'timeline') {
        const position = this.parentElement.children.indexOf(this);
        const top = this.parentElement.children.slice(0, position).reduce((height, item) => height + (item.dataset.messageId ? 80 : 20), 0) - elements.get('scroller').scrollTop;
        return { top, bottom: top + (this.dataset.messageId ? 80 : 20) };
      }
      return { top: 0, bottom: this.clientHeight };
    }
  }
  for (const match of html.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) elements.set(match[2], new Element(match[1], match[2]));
  const calls = [];
  let invoke = async () => ({});
  const bridge = { invoke(method, value) { calls.push({ method, value }); return invoke(method, value); }, onEvent() {} };
  const context = vm.createContext({
    window: { jianjian: bridge, addEventListener() {} },
    document: { getElementById: id => elements.get(id), createElement: tag => new Element(tag) },
    crypto: webcrypto, console, setTimeout: () => 1, clearTimeout() {}
  });
  assert.match(source, /\nboot\(\);\s*$/);
  vm.runInContext(source.replace(/\nboot\(\);\s*$/, '\n'), context, { filename: 'desktop/floating.js' });
  vm.runInContext(`
    state.session = { username: 'test', deviceId: 'local' }; state.connected = true;
    globalThis.probe = { state, refresh, applyEvent, handleEvent, send, loadSession, clearSession, render, scrollState,
      get sending() { return sending; }, get retryDraft() { return retryDraft; } };
  `, context);
  return { app: context.probe, elements, calls, setInvoke(fn) { invoke = fn; } };
}
const message = seq => ({ id: `message-${seq}`, seq, kind: 'text', text: `消息 ${seq}`, device_id: 'phone', device_name: '我的手机', platform: 'Android', created_at: 1700000000000 + seq });
const range = (low, high) => Array.from({ length: high - low + 1 }, (_, index) => message(index + low));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const submit = () => ({ preventDefault() {} });

test('floating history merges live changes during a refresh and retains only the latest 50', async () => {
  const { app, setInvoke } = harness();
  const response = deferred(); setInvoke(() => response.promise);
  const loading = app.refresh();
  app.applyEvent({ type: 'message', data: message(61) });
  app.applyEvent({ type: 'deleted', data: { id: 'message-55' } });
  response.resolve({ items: range(1, 60).reverse() }); await loading;
  assert.equal(app.state.items.length, 50);
  assert.equal(app.state.items[0].seq, 11);
  assert.equal(app.state.items.at(-1).seq, 61);
  assert(!app.state.items.some(item => item.seq === 55));
});

test('reconnect replaces the snapshot including deletions made while offline', async () => {
  const { app, setInvoke, calls } = harness();
  app.state.items = range(1, 50); app.state.loaded = true;
  setInvoke(async () => ({ items: range(20, 69).filter(item => item.seq !== 35) }));
  await app.handleEvent({ type: 'status', connected: false });
  await app.handleEvent({ type: 'status', connected: true });
  await app.handleEvent({ type: 'ready', data: {} });
  assert.equal(calls.filter(call => call.method === 'floatingList').length, 1);
  assert.equal(app.state.items[0].seq, 20);
  assert.equal(app.state.items.at(-1).seq, 69);
  assert(!app.state.items.some(item => item.seq === 35));
});

test('latest list request wins without losing a message delivered during both requests', async () => {
  const { app, setInvoke } = harness();
  const first = deferred(), second = deferred(); let count = 0;
  setInvoke(() => ++count === 1 ? first.promise : second.promise);
  const one = app.refresh(), two = app.refresh();
  app.applyEvent({ type: 'message', data: message(101) });
  second.resolve({ items: range(60, 100) }); await two;
  first.resolve({ items: range(1, 50) }); await one;
  assert.equal(app.state.items[0].seq, 60);
  assert.equal(app.state.items.at(-1).seq, 101);
});

test('failed sends retain the draft and retry identifier to avoid duplicate messages', async () => {
  const { app, elements, setInvoke, calls } = harness();
  const input = elements.get('message-input'); input.value = '重要内容\n第二行';
  setInvoke(async () => { throw new Error('网络中断'); });
  await app.send(submit());
  assert.equal(input.value, '重要内容\n第二行'); assert.equal(app.sending, false);
  const clientId = app.retryDraft.clientId;
  setInvoke(async (method, value) => ({ ...message(1), text: value.text, device_id: 'local' }));
  await app.send(submit());
  assert.equal(calls[0].value.clientId, clientId); assert.equal(calls[1].value.clientId, clientId);
  assert.equal(input.value, ''); assert.equal(app.state.items.length, 1); assert.equal(app.retryDraft, null);
});

test('session changes clear drafts and invalidate pending list and send results', async () => {
  const { app, elements, setInvoke } = harness();
  const oldList = deferred(), oldSend = deferred();
  setInvoke(method => method === 'floatingList' ? oldList.promise : oldSend.promise);
  elements.get('message-input').value = '旧账号的内容';
  const sending = app.send(submit()), loading = app.refresh();
  setInvoke(async method => method === 'floatingState'
    ? { session: { username: 'new-account', deviceId: 'new-device' }, info: {}, connected: true }
    : { items: [message(500)] });
  await app.handleEvent({ type: 'session' });
  assert.equal(elements.get('message-input').value, ''); assert.equal(app.retryDraft, null);
  elements.get('message-input').value = '新账号草稿';
  oldList.resolve({ items: range(1, 10) }); oldSend.resolve(message(11));
  await Promise.all([sending, loading]);
  assert.equal(app.state.items.length, 1); assert.equal(app.state.items[0].seq, 500);
  assert.equal(elements.get('message-input').value, '新账号草稿');
});

test('authentication expiry also invalidates a pending session-state response', async () => {
  const { app, setInvoke, elements } = harness(); const response = deferred();
  setInvoke(() => response.promise); const loading = app.loadSession();
  await app.handleEvent({ type: 'auth' });
  response.resolve({ session: { username: 'expired', deviceId: 'old' }, connected: true }); await loading;
  assert.equal(app.state.session, null); assert.equal(elements.get('login-state').hidden, false);
});

test('status events during initial state loading override its stale snapshot and preserve reconnect refresh', async () => {
  const { app, setInvoke, elements, calls } = harness(); const response = deferred();
  setInvoke(method => method === 'floatingState' ? response.promise : Promise.resolve({ items: [message(1)] }));
  const loading = app.loadSession();
  await app.handleEvent({ type: 'status', connected: true });
  await app.handleEvent({ type: 'ready', data: {} });
  await app.handleEvent({ type: 'status', connected: false });
  response.resolve({ session: { username: 'test', deviceId: 'local' }, info: {}, connected: true });
  await loading;
  assert.equal(app.state.connected, false);
  assert.equal(elements.get('connection-text').textContent, '已断线 · 自动重连中');
  assert.equal(calls.filter(call => call.method === 'floatingList').length, 1);
  await app.handleEvent({ type: 'status', connected: true });
  assert.equal(app.state.connected, true);
  assert.equal(elements.get('connection-text').textContent, '已连接 · 实时同步');
  assert.equal(calls.filter(call => call.method === 'floatingList').length, 2);
});

test('Chinese composition and Shift+Enter never send; ordinary Enter does', async () => {
  const { elements, setInvoke, calls } = harness();
  setInvoke(async () => message(1));
  const input = elements.get('message-input'); input.value = '中文内容';
  input.oncompositionstart(); input.onkeydown({ ...submit(), key: 'Enter' }); input.oncompositionend();
  input.onkeydown({ ...submit(), key: 'Enter', isComposing: true });
  input.onkeydown({ ...submit(), key: 'Enter', keyCode: 229 });
  input.onkeydown({ ...submit(), key: 'Enter', shiftKey: true });
  assert.equal(calls.length, 0);
  input.onkeydown({ ...submit(), key: 'Enter' });
  await Promise.resolve();
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'floatingSend');
});

test('live messages preserve the reading anchor and show the new-message button', () => {
  const { app, elements } = harness(); app.state.items = range(1, 50); app.state.loaded = true; app.render({ bottom: true });
  const scroller = elements.get('scroller'); scroller.scrollTop = 800;
  const before = app.scrollState();
  app.applyEvent({ type: 'message', data: message(51) });
  const after = app.scrollState();
  assert.equal(after.id, before.id); assert.equal(after.offset, before.offset);
  assert.equal(elements.get('latest-button').hidden, false);
  assert.equal(elements.get('latest-button').textContent, '↓ 1 条新消息');
});

test('message content stays literal, and file cards use the main-window bridge', async () => {
  const { app, elements, calls, setInvoke } = harness(); setInvoke(async () => ({}));
  const text = '<img src=x onerror=alert(1)> & 中文';
  app.state.items = [{ ...message(1), text }, { ...message(2), kind: 'file', filename: '资料.zip', expires_at: Date.now() + 10000 }]; app.render();
  const articles = elements.get('timeline').children.filter(child => child.dataset.messageId);
  assert.equal(articles[0].children[1].children[0].textContent, text);
  assert.equal(articles[0].children[1].children[0].children.length, 0);
  await articles[0].children[2].children[0].onclick();
  assert.equal(calls.at(-1).method, 'copy'); assert.equal(calls.at(-1).value, text);
  await articles[1].children[1].onclick();
  assert.equal(calls.at(-1).method, 'showMain'); assert.equal(calls.at(-1).value.messageId, 'message-2');
});
