import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const { fitBounds } = require('../desktop/floating-window.cjs');
const source = readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8');
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function host(t, fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) }), options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jianjian-floating-'));
  const windows = []; let handler, menu, engine;
  const session = username => ({ server: 'http://127.0.0.1:8787', username, token: username[0].repeat(43), deviceId: username + '-device' });
  if (options.persistedUser) {
    writeFileSync(join(dir, 'session.enc'), JSON.stringify({ session: session(options.persistedUser), accounts: {} }));
    writeFileSync(join(dir, 'floating-window.json'), JSON.stringify({ enabled: true }));
  }
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.visible = options.show !== false; this.dead = false;
      this.bounds = { x: options.x || 0, y: options.y || 0, width: options.width, height: options.height };
      this.webContents = Object.assign(new EventEmitter(), { events: [], mainFrame: {},
        send(type, value) { this.events.push(value); }, setWindowOpenHandler() {}, isLoadingMainFrame() { return false; } });
      windows.push(this);
    }
    loadFile(path) { this.webContents.mainFrame.url = require('node:url').pathToFileURL(path).href; queueMicrotask(() => this.emit('ready-to-show')); }
    isDestroyed() { return this.dead; }
    isMinimized() { return false; }
    setAlwaysOnTop(value) { this.top = value; }
    getNormalBounds() { return this.bounds; }
    setBounds(value) { this.bounds = value; }
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    destroy() { this.dead = true; this.emit('closed'); }
  }
  const app = Object.assign(new EventEmitter(), { setName() {}, requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), getPath: () => dir, quit() {} });
  const screen = Object.assign(new EventEmitter(), { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) });
  screen.getDisplayMatching = screen.getPrimaryDisplay;
  class Engine {
    constructor(options) { this.emit = options.emit; this.starts = 0; engine = this; }
    start(session) { this.session = session; this.starts++; this.emit({ type: 'status', connected: true }); }
    stop() { this.session = null; }
    copy(text) { this.copied = text; }
  }
  class RealEngine extends require('../desktop/sync-engine.cjs').SyncEngine {
    constructor(config) { super({ ...config, fetchImpl }); this.starts = 0; engine = this; }
    start(session) { this.starts++; return super.start(session); }
  }
  const electron = { app, screen, BrowserWindow: FakeWindow, ipcMain: { handle(name, fn) { handler = fn; } }, clipboard: { readText: () => '', writeText() {} },
    Tray: class extends EventEmitter { setToolTip() {} setContextMenu(items) { menu = items; } },
    Menu: { buildFromTemplate: x => x }, nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    safeStorage: { isEncryptionAvailable: () => !!options.persistedUser, encryptString: value => Buffer.from(value), decryptString: value => value.toString('utf8') }, dialog: { showSaveDialog: options.showSaveDialog }, session: { defaultSession: { setPermissionRequestHandler() {} } } };
  vm.runInNewContext(source, { require(name) { if (name === 'electron') return electron; if (name === './sync-engine.cjs') return { SyncEngine: options.realEngine ? RealEngine : Engine }; if (name === './downloads.cjs') return require('../desktop/downloads.cjs'); if (name === './mcp.cjs') return require('../desktop/mcp.cjs'); if (name === './floating-window.cjs') return require('../desktop/floating-window.cjs'); return require(name); },
    __dirname: resolve('desktop'), process: { platform: 'win32', env: {}, argv: [] }, console, Buffer,
    URL, fetch: fetchImpl, setTimeout, clearTimeout, AbortController, AbortSignal });
  await Promise.resolve();
  t.after(() => { app.emit('before-quit'); rmSync(dir, { recursive: true, force: true }); });
  const invoke = (target, method, value) => handler({ sender: target.webContents, senderFrame: target.webContents.mainFrame }, method, value);
  if (!options.skipLogin) {
    await invoke(windows[0], 'saveSession', session('alpha'));
    await invoke(windows[0], 'connect');
    await invoke(windows[0], 'showFloating');
  }
  return { windows, invoke, session, handler, app, dir, engine, get menu() { return menu; } };
}

test('floating window shares the account but cannot read credentials or invoke main-only operations', async t => {
  const f = await host(t); const small = f.windows[1];
  const state = await f.invoke(small, 'floatingState');
  assert.equal(state.session.username, 'alpha'); assert.equal(state.connected, true);
  assert.equal(state.session.token, undefined); assert.equal(state.session.server, undefined);
  await assert.rejects(f.invoke(small, 'getState'), /拒绝/);
  await assert.rejects(f.invoke(small, 'saveSession', f.session('beta')), /拒绝/);
  await assert.rejects(f.invoke(f.windows[0], 'floatingSend', { text: 'hello' }), /拒绝/);
  await assert.rejects(f.handler({ sender: small.webContents, senderFrame: { url: small.webContents.mainFrame.url } }, 'floatingState'), /拒绝/);
  assert.equal(small.top, true); assert.equal(small.options.resizable, true);
});

test('hide, reopen and native close retain the shared login and synchronize to both windows', async t => {
  const message = { id: 'a'.repeat(36), kind: 'text', text: 'hello', seq: 1 };
  const f = await host(t, async () => ({ ok: true, status: 201, json: async () => message }));
  const small = f.windows[1];
  await f.invoke(small, 'floatingHide'); assert.equal(small.visible, false);
  assert.equal((await f.invoke(f.windows[0], 'getState')).session.username, 'alpha');
  await f.invoke(f.windows[0], 'showFloating'); assert.equal(f.windows.length, 2); assert.equal(small.visible, true);
  await f.invoke(small, 'floatingSend', { text: 'hello', clientId: 'same-retry-id-123456' });
  for (const w of f.windows) assert.ok(w.webContents.events.some(e => e.type === 'message' && e.data.id === message.id));
  let prevented = false; small.emit('close', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(small.visible, false);
  assert.ok(f.menu.some(m => m.label === '打开悬浮窗' && m.enabled));
});

test('account changes abort floating requests and reject late old-account data', async t => {
  const response = defer(); let signal;
  const f = await host(t, async (_url, options) => { signal = options.signal; return response.promise; });
  const small = f.windows[1]; const pending = f.invoke(small, 'floatingList');
  await f.invoke(f.windows[0], 'saveSession', f.session('beta'));
  assert.equal(signal.aborted, true); assert.equal(small.dead, true);
  response.resolve({ ok: true, status: 200, json: async () => ({ items: [{ text: 'old account' }] }) });
  await assert.rejects(pending, /账号已切换/);
  await assert.rejects(f.invoke(small, 'copy', 'old account'), /拒绝/);
});

test('a pending save dialog cannot start a file download after the account changes', async t => {
  const dialog = defer(); let requests = 0;
  const f = await host(t, async () => { requests++; throw new Error('Unexpected download'); }, { showSaveDialog: () => dialog.promise });
  const pending = f.invoke(f.windows[0], 'download', { id: 'a'.repeat(36), filename: 'private.txt' });
  await f.invoke(f.windows[0], 'saveSession', f.session('beta'));
  dialog.resolve({ canceled: false, filePath: join(f.dir, 'private.txt') });
  assert.equal((await pending).canceled, true); assert.equal(requests, 0);
});

test('hiding saves size and position, reopening reuses them, and app exit preserves an open window', async t => {
  const f = await host(t); const small = f.windows[1];
  const bounds = { x: 320, y: 140, width: 420, height: 620 };
  small.setBounds(bounds);
  await f.invoke(small, 'floatingHide');
  let saved = JSON.parse(readFileSync(join(f.dir, 'floating-window.json'), 'utf8'));
  assert.deepEqual(saved.bounds, bounds); assert.equal(saved.enabled, false);
  await f.invoke(f.windows[0], 'showFloating'); assert.deepEqual(small.getNormalBounds(), bounds);
  f.app.emit('before-quit');
  saved = JSON.parse(readFileSync(join(f.dir, 'floating-window.json'), 'utf8'));
  assert.equal(saved.enabled, true); assert.deepEqual(saved.bounds, bounds);
});

test('switching accounts after response parsing cannot broadcast the old send result', async t => {
  const parsed = defer();
  const item = { id: 'c'.repeat(36), kind: 'text', text: 'old private content', seq: 1 };
  const f = await host(t, async () => ({ ok: true, status: 201, json: () => parsed.promise }));
  const pending = f.invoke(f.windows[1], 'floatingSend', { text: item.text, clientId: 'old-send-client-id-1234' })
    .then(value => ({ status: 'fulfilled', value }), error => ({ status: 'rejected', error }));
  await nextTurn();
  // Resolve parsing first. The API helper's continuation checks the old session,
  // then the account switch runs before its caller resumes to broadcast the item.
  parsed.resolve(item);
  await Promise.resolve().then(() => f.invoke(f.windows[0], 'saveSession', f.session('beta')));
  const result = await pending;
  assert.equal((await f.invoke(f.windows[0], 'getState')).session.username, 'beta');
  assert.equal(result.status, 'rejected');
  assert(!f.windows[0].webContents.events.some(event => event.type === 'message' && event.data.id === item.id));
});

test('expired login closes the small window and disables its tray entry', async t => {
  const f = await host(t, async () => ({ ok: false, status: 401 }));
  await assert.rejects(f.invoke(f.windows[1], 'floatingList'));
  assert.equal(f.windows[1].dead, true); assert.equal((await f.invoke(f.windows[0], 'getState')).session, null);
  assert.ok(f.windows[0].webContents.events.some(e => e.type === 'auth'));
  assert.ok(f.menu.some(m => m.label === '打开悬浮窗' && !m.enabled));
});

test('placement survives negative monitor coordinates and clamps off-screen windows into the work area', () => {
  const area = { x: -1920, y: 0, width: 1920, height: 1040 };
  assert.deepEqual(fitBounds({ x: -1700, y: 100, width: 360, height: 520 }, area), { x: -1700, y: 100, width: 360, height: 520 });
  assert.deepEqual(fitBounds({ x: 3000, y: 2000, width: 360, height: 520 }, area), { x: -360, y: 520, width: 360, height: 520 });
  assert.deepEqual(fitBounds({ width: 5000, height: 6000 }, { x: 0, y: 0, width: 800, height: 600 }), { x: 0, y: 0, width: 800, height: 600 });
});

test('persisted login starts the shared engine offline and reconnects both windows without renderer connect', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let attempts = 0;
  const reading = defer();
  const f = await host(t, async url => {
    assert(url.endsWith('/api/events'));
    if (++attempts === 1) throw new Error('offline at startup');
    return { ok: true, status: 200, body: { getReader: () => ({
      read: () => reading.promise,
      cancel() { reading.resolve({ done: true }); return Promise.resolve(); },
      releaseLock() {}
    }) } };
  }, { persistedUser: 'alpha', skipLogin: true, realEngine: true });
  await nextTurn();
  assert.equal(f.engine.starts, 1, 'main process must start sync without renderer IPC');
  assert.equal(attempts, 1);
  assert.equal(f.windows.length, 2, 'previously enabled floating window is restored');
  assert.equal(f.engine.session.username, 'alpha');
  assert.equal((await f.invoke(f.windows[1], 'floatingState')).connected, false);
  assert(f.engine.reconnectTimer, 'offline startup must schedule an actual reconnect');
  t.mock.timers.tick(3000);
  await nextTurn();
  assert.equal(attempts, 2);
  assert.equal(f.engine.starts, 1);
  assert.equal((await f.invoke(f.windows[1], 'floatingState')).connected, true);
  for (const target of f.windows) assert(target.webContents.events.some(event => event.type === 'status' && event.connected));
});
