import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const appSource = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

// Execute the shipped application, replacing only browser services and DOM painting.
// Pagination, filter invalidation and event reconciliation remain the real app logic.
function harness({ native = null } = {}) {
  const elements = new Map();
  const timers = new Map();
  const frames = new Map();
  let timerId = 0;
  class Element {
    constructor(id, tag = 'div', classes = '') {
      this.id = id; this.tagName = tag.toUpperCase(); this.value = ''; this.disabled = false;
      this.textContent = ''; this.style = {}; this.dataset = {}; this.children = [];
      this.attributes = new Map(); this.open = false; this.listeners = new Map();
      const values = new Set(classes.split(/\s+/).filter(Boolean));
      this.classList = {
        add: (...items) => items.forEach(item => values.add(item)),
        remove: (...items) => items.forEach(item => values.delete(item)),
        contains: item => values.has(item),
        toggle: (item, force) => {
          const next = force === undefined ? !values.has(item) : force;
          next ? values.add(item) : values.delete(item); return next;
        }
      };
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    querySelector() { return { textContent: '' }; }
    querySelectorAll(query) {
      const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
      return query === '[data-message-id]' ? descendants.filter(child => child.dataset.messageId) : descendants;
    }
    getBoundingClientRect() { return { top: 0, bottom: 0 }; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    dispatchEvent(event) { this[`on${event.type}`]?.(event); this.listeners.get(event.type)?.(event); return !event.defaultPrevented; }
    focus() { this.focused = true; }
    scrollIntoView() { this.scrolledIntoView = true; }
  }
  for (const match of html.matchAll(/<([a-z][\w-]*)\b[^>]*\bid="([^"]+)"([^>]*)>/gi)) {
    elements.set(match[2], new Element(match[2], match[1], /\bclass="([^"]*)"/.exec(match[0])?.[1] || ''));
  }
  const body = new Element('body', 'body');
  const document = {
    body, documentElement: { style: { setProperty() {} }, classList: { toggle() {} } },
    getElementById: id => elements.get(id) || null,
    querySelectorAll: query => query === 'dialog[open]' ? [...elements.values()].filter(item => item.tagName === 'DIALOG' && item.open) : [],
    querySelector: query => document.querySelectorAll(query)[0] || null,
    addEventListener() {}, createElement: tag => new Element('', tag)
  };
  const storage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  const context = vm.createContext({
    document, window: { addEventListener() {}, jianjian: native }, localStorage: storage, sessionStorage: storage,
    crypto: webcrypto, URL, URLSearchParams, Event, AbortController, DOMException, Blob, console,
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame(callback) { const id = ++timerId; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); }
  });
  assert.match(appSource, /\nboot\(\);\s*$/);
  vm.runInContext(appSource.replace(/\nboot\(\);\s*$/, '\n'), context, { filename: 'web/app.js' });
  vm.runInContext(`
    const realRenderTimeline = renderTimeline;
    renderTimeline = () => {};
    state.session = { token: 'test-session', server: 'https://test.invalid', deviceId: 'local' };
    globalThis.probe = {
      get downloadTasks() { return downloadTasks; }, downloadFile, get attachments() { return attachments; }, addAttachments, compose, get state() { return state; }, refresh, applyLiveEvent, confirmAction, handleEvent, resizeMessageInput, renderSettings, enter,
      useTimeline() { renderTimeline = realRenderTimeline; },
      set ready(value) { appReady = value; },
      back: () => window.__handleNativeBack(),
      setApi(fn) { api = fn; },
      get activeLoads() { return activeLoads.size; }
    };
  `, context);
  return {
    ...context.probe, state: context.probe.state, probe: context.probe, elements,
    window: context.window, document,
    flushFrames() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); }
  };
}

const message = (seq, kind = 'text') => ({
  id: `message-${seq}`, seq, kind, text: `消息 ${seq}`, device_id: 'other',
  device_name: '测试手机', platform: 'Android', created_at: 1700000000000 + seq
});
const range = (high, low) => Array.from({ length: high - low + 1 }, (_, index) => message(high - index));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('older pages preserve more than 50 messages and simultaneous live changes', async () => {
  const app = harness();
  app.state.items = range(150, 101); app.state.nextBefore = 101;
  const page = deferred();
  app.setApi(path => {
    assert.equal(new URL(path, 'https://test.invalid').searchParams.get('before'), '101');
    return page.promise;
  });
  const loading = app.refresh(true);
  app.applyLiveEvent({ type: 'message', data: message(151) });
  app.applyLiveEvent({ type: 'deleted', data: { id: 'message-120' } });
  // A deletion inside the still-loading page must not reappear when its snapshot arrives.
  app.applyLiveEvent({ type: 'deleted', data: { id: 'message-80' } });
  page.resolve({ items: range(100, 51), nextBefore: 51 });
  await loading;
  assert.equal(app.state.items.length, 99);
  assert.equal(app.state.items[0].seq, 151);
  assert.equal(app.state.items.at(-1).seq, 51);
  assert(!app.state.items.some(item => [80, 120].includes(item.seq)));
  assert.equal(app.state.nextBefore, 51);
  assert.equal(app.probe.activeLoads, 0);
});

test('reconnect reconciles all loaded history, missed messages and offline deletions', async () => {
  const app = harness();
  app.state.items = range(150, 51); app.state.nextBefore = 51;
  const remote = range(190, 1).filter(item => ![70, 120].includes(item.seq));
  const calls = [];
  app.setApi(async path => {
    const query = new URL(path, 'https://test.invalid').searchParams;
    const before = Number(query.get('before')) || Infinity;
    calls.push(before);
    const items = remote.filter(item => item.seq < before).slice(0, 50);
    return { items, nextBefore: items.length === 50 ? items.at(-1).seq : null };
  });
  await app.refresh();
  assert.equal(calls.length, 3);
  for (let seq = 51; seq <= 190; seq++) {
    assert.equal(app.state.items.some(item => item.seq === seq), ![70, 120].includes(seq), `message ${seq}`);
  }
  assert(app.state.items.length > 100);
  assert.equal(app.state.items[0].seq, 190);
  assert.equal(app.state.nextBefore, app.state.items.at(-1).seq);
});

test('a filter reset invalidates an older page already in flight', async () => {
  const app = harness();
  app.state.items = range(150, 101); app.state.nextBefore = 101;
  const page = deferred();
  app.setApi(path => {
    const query = new URL(path, 'https://test.invalid').searchParams;
    if (query.has('before')) return page.promise;
    assert.equal(query.get('kind'), 'clipboard');
    return Promise.resolve({ items: [message(201, 'clipboard')], nextBefore: null });
  });
  const loading = app.refresh(true);
  app.state.filter = 'clipboard';
  await app.refresh(false, { reset: true });
  page.resolve({ items: range(100, 51), nextBefore: 51 });
  await loading;
  assert.equal(app.state.items.length, 1);
  assert.equal(app.state.items[0].seq, 201);
  assert.equal(app.state.nextBefore, null);
  assert.equal(app.elements.get('load-more').disabled, false);
});

test('live events respect the current filter while retaining loaded matching history', () => {
  const app = harness();
  app.state.filter = 'clipboard'; app.state.q = 'needle';
  app.state.items = Array.from({ length: 80 }, (_, index) => ({ ...message(100 - index, 'clipboard'), text: 'needle history' }));
  app.applyLiveEvent({ type: 'message', data: { ...message(101, 'clipboard'), text: 'a NEEDLE arrives' } });
  app.applyLiveEvent({ type: 'message', data: { ...message(102), text: 'needle but wrong kind' } });
  app.applyLiveEvent({ type: 'message', data: message(103, 'clipboard') });
  assert.equal(app.state.items.length, 81);
  assert.equal(app.state.items[0].seq, 101);
  assert.equal(app.state.items.at(-1).seq, 21);
});

test('mobile settings binding opens the dialog and native back cancels confirmation', async () => {
  const app = harness();
  assert.equal(typeof app.elements.get('mobile-settings-nav').onclick, 'function');
  app.elements.get('mobile-settings-nav').onclick();
  assert.equal(app.elements.get('settings-dialog').open, true);
  app.back();
  assert.equal(app.elements.get('settings-dialog').open, false);
  const decision = app.confirmAction('删除？', '测试确认');
  assert.equal(app.elements.get('confirm-dialog').open, true);
  assert.equal(app.back(), true);
  assert.equal(await decision, false);
  assert.equal(app.elements.get('confirm-dialog').open, false);
});

test('Android keyboard visibility remains explicit after rotation and before login', async () => {
  const app = harness();
  app.state.session = null;
  app.state.info = { platform: 'Android', keyboardVisible: false, insetsHandled: true };
  app.window.visualViewport = { height: 260, width: 800 };
  app.document.activeElement = app.elements.get('message-input');
  app.elements.get('message-input').scrollHeight = 220;
  Object.assign(app.elements.get('conversation-scroll'), { scrollHeight: 500, clientHeight: 100, scrollTop: 400 });
  await app.handleEvent({ type: 'viewport', keyboardVisible: true });
  app.flushFrames();
  assert.equal(app.document.body.classList.contains('keyboard-open'), true);
  assert.equal(app.elements.get('message-input').style.height, '65px');
  // A width change resets heuristic viewport baselines, but must not override Android's IME state.
  app.window.visualViewport = { height: 240, width: 500 };
  await app.handleEvent({ type: 'viewport', keyboardVisible: true });
  app.flushFrames();
  assert.equal(app.document.body.classList.contains('keyboard-open'), true);
  await app.handleEvent({ type: 'viewport', keyboardVisible: false });
  app.flushFrames();
  assert.equal(app.document.body.classList.contains('keyboard-open'), false);
});

test('message input height adapts to short viewports without exceeding its cap', () => {
  const app = harness();
  const input = app.elements.get('message-input'); input.scrollHeight = 400;
  for (const [height, expected] of [[150, '44px'], [300, '75px'], [900, '120px']]) {
    app.window.visualViewport = { height };
    app.resizeMessageInput(false);
    assert.equal(input.style.height, expected);
    assert.equal(input.style.overflowY, 'auto');
  }
});

test('floating-window entry is exposed only by a supported native host', async () => {
  const calls = [];
  const app = harness({ native: { invoke: async method => calls.push(method) } });
  const button = app.elements.get('floating-window-button');
  assert.equal(button.classList.contains('hidden'), true);
  app.state.info = { platform: 'Windows', floatingWindow: true };
  app.renderSettings();
  assert.equal(button.classList.contains('hidden'), false);
  await button.onclick();
  assert.deepEqual(calls, ['showFloating']);
  app.state.info = { platform: 'Android' };
  app.renderSettings();
  assert.equal(button.classList.contains('hidden'), true);
  await button.onclick();
  assert.deepEqual(calls, ['showFloating']);
  const web = harness();
  web.state.info.floatingWindow = true;
  web.renderSettings();
  assert.equal(web.elements.get('floating-window-button').classList.contains('hidden'), true);
});

const fileMessage = seq => ({ ...message(seq, 'file'), filename: '设计稿.pdf', size: 2048, expires_at: Date.now() + 86400000 });

test('opening a file from the floating window clears filters and finds it without downloading', async () => {
  const app = harness(); app.probe.ready = true; app.probe.useTimeline();
  app.state.filter = 'clipboard'; app.state.q = 'old search';
  app.elements.get('search').value = 'old search';
  app.elements.get('settings-dialog').showModal();
  const paths = [];
  app.setApi(async path => {
    paths.push(path);
    const query = new URL(path, 'https://test.invalid').searchParams;
    assert.equal(query.get('q'), '');
    assert.equal(query.has('before'), false);
    return query.get('kind') === 'file'
      ? { items: [fileMessage(20)], nextBefore: null }
      : { items: range(100, 51), nextBefore: 51 };
  });
  await app.handleEvent({ type: 'focusMessage', id: 'message-20' });
  assert.equal(paths.length, 2);
  assert.equal(app.state.filter, 'file');
  assert.equal(app.elements.get('search').value, '');
  assert.equal(app.elements.get('settings-dialog').open, false);
  const card = app.elements.get('timeline').querySelectorAll('[data-message-id]')[0];
  assert.equal(card.dataset.messageId, 'message-20');
  assert.equal(card.focused, true);
  assert.equal(card.scrolledIntoView, true);
  assert.equal(card.classList.contains('focused-message'), true);
  assert(paths.every(path => path.startsWith('/messages?')));
});

test('a missing floating-window file stops lookup after two pages and offers manual search', async () => {
  const app = harness(); app.probe.ready = true; app.probe.useTimeline();
  let calls = 0;
  app.setApi(async () => { calls++; return { items: [], nextBefore: 1 }; });
  await app.handleEvent({ type: 'focusMessage', id: 'deleted-message' });
  assert.equal(calls, 2);
  assert.equal(app.state.filter, 'file');
  assert.match(app.elements.get('toast').textContent, /搜索文件名/);
});

test('a floating-window file request waits for main-window session restoration', async () => {
  const app = harness({ native: { invoke: async () => {} } }); app.probe.useTimeline();
  app.state.session = { ...app.state.session, username: 'preview', role: 'user', config: { maxFileMB: 500, retentionDays: 7 } };
  let pages = 0;
  app.setApi(async path => {
    if (path === '/devices') return [];
    pages++; return { items: [fileMessage(20)], nextBefore: null };
  });
  await app.handleEvent({ type: 'focusMessage', id: 'message-20' });
  assert.equal(pages, 0);
  await app.enter();
  assert.equal(pages, 2);
  const card = app.elements.get('timeline').querySelectorAll('[data-message-id]')[0];
  assert.equal(card.focused, true);
});

test('changing filters cancels an in-flight floating-window file lookup', async () => {
  const app = harness(); app.probe.ready = true;
  const first = deferred(); let calls = 0;
  app.setApi(async () => {
    calls++;
    return calls === 1 ? first.promise : { items: [message(201, 'clipboard')], nextBefore: null };
  });
  const locating = app.handleEvent({ type: 'focusMessage', id: 'message-20' });
  app.state.filter = 'clipboard';
  await app.refresh(false, { reset: true });
  first.resolve({ items: [], nextBefore: null });
  await locating;
  assert.equal(calls, 2);
  assert.equal(app.state.filter, 'clipboard');
  assert.equal(app.state.items[0].seq, 201);
});


test('pasting images stages removable attachments without sending; text paste remains native', () => {
  const app = harness(); app.state.session.config = { maxFileMB: 500 };
  const image = { name: 'paste.png', size: 1024, type: 'image/png' };
  let prevented = false;
  const paste = app.elements.get('message-input').listeners.get('paste');
  paste({ clipboardData: { items: [{ kind: 'file', getAsFile: () => image }] }, preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(app.probe.attachments.length, 1);
  const row = app.elements.get('pending-attachments').children[0]; row.children[1].onclick();
  assert.equal(app.probe.attachments.length, 0);
  prevented = false;
  paste({ clipboardData: { items: [{ kind: 'string' }] }, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
});


test('browser download shows connecting and streams bytes to disk before reporting saved', async () => {
  const app = harness(); let written = 0, closed = false;
  app.window.showSaveFilePicker = async () => ({ createWritable: async () => ({ write: async chunk => { written += chunk.byteLength; }, close: async () => { closed = true; }, abort: async () => {} }) });
  const response = deferred(); app.probe.setApi(() => response.promise);
  const button = { disabled: false }; const pending = app.probe.downloadFile({ id: 'large-file', filename: 'large.bin', size: 4096 }, button);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal([...app.probe.downloadTasks.values()][0].status, 'starting');
  response.resolve(new Response(new Uint8Array(4096), { headers: { 'Content-Length': '4096' } })); await pending;
  assert.equal(written, 4096); assert.equal(closed, true); assert.equal([...app.probe.downloadTasks.values()][0].status, 'completed'); assert.equal(button.disabled, false);
});
test('browser download failure keeps a visible result and duplicate requests are blocked', async () => {
  const app = harness(); const response = deferred(); let requests = 0;
  app.probe.setApi(() => { requests++; return response.promise; });
  const item = { id: 'large-file', filename: 'large.bin', size: 4096 };
  const pending = app.probe.downloadFile(item, { disabled: false });
  await app.probe.downloadFile(item, { disabled: false }); assert.equal(requests, 1);
  response.resolve(Promise.reject(new Error('network disconnected'))); await pending;
  assert.equal([...app.probe.downloadTasks.values()][0].status, 'failed'); assert.match([...app.probe.downloadTasks.values()][0].error, /network/);
});
