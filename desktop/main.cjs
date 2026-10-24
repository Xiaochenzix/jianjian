const { app, BrowserWindow, ipcMain, clipboard, Tray, Menu, nativeImage, safeStorage, dialog, screen, session: electronSession } = require('electron');
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('node:fs');
const { unlink } = require('node:fs/promises');
const { join, basename } = require('node:path');
const { hostname } = require('node:os');
const { pathToFileURL } = require('node:url');
const { SyncEngine } = require('./sync-engine.cjs');
const { createFloatingController } = require('./floating-window.cjs');
const { createDownloads } = require('./downloads.cjs');
const { createMcp } = require('./mcp.cjs');
app.setName('剪剪');
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
let window, tray, floating, quitting = false, current = null, vault = { session: null, accounts: {} }, prefs = defaults();
let connected = false, sessionGeneration = 0;
const floatingRequests = new Set();
const page = pathToFileURL(join(__dirname, '..', 'web', 'index.html')).href;
const wayland = process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);
function defaults() { return { autoSend: false, autoWrite: false, autoStart: false, background: false }; }
const emit = value => {
  if (value.type === 'status') connected = !!value.connected;
  if (value.type === 'auth') clearSession();
  for (const target of [window, floating?.window]) {
    if (target && !target.isDestroyed()) target.webContents.send('jianjian:event', value);
  }
};
const engine = new SyncEngine({ clipboard, emit, getPrefs: () => prefs });
const downloads = createDownloads({ emit });
const mcp = createMcp({ getSession: () => current, emit });
function key(s = current) { return `${s.server}:${s.username}`; }
function vaultPath() { return join(app.getPath('userData'), 'session.enc'); }
function canEncrypt() { return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'); }
function persist() {
  if (!canEncrypt()) return; // Session remains in memory if no OS keyring is available.
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(vaultPath(), safeStorage.encryptString(JSON.stringify(vault)), { mode: 0o600 });
}
function loadVault() {
  try { if (canEncrypt() && existsSync(vaultPath())) vault = JSON.parse(safeStorage.decryptString(readFileSync(vaultPath()))); } catch { vault = { session: null, accounts: {} }; }
  current = vault.session; prefs = current ? { ...defaults(), ...vault.accounts[key()] } : defaults();
}
function validSession(s) {
  if (!s || typeof s.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(s.token) || typeof s.deviceId !== 'string' || typeof s.username !== 'string') throw new Error('登录数据无效');
  const u = new URL(s.server);
  if (u.username || u.password || u.origin !== s.server || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))) throw new Error('服务器地址必须使用 HTTPS');
  return s;
}
function show() { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } }
function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开剪剪', click: show },
    ...(floating ? [{ label: floating.visible ? '关闭悬浮窗' : '打开悬浮窗', enabled: !!current,
      click: () => { if (floating.visible) floating.hide(); else showFloating(); } }] : []),
    ...(process.platform === 'win32' ? [{ label: '启用 MCP（AI 可读消息及发送文件）', type: 'checkbox', checked: !!mcp.config(), click: async item => { try { if (item.checked) await mcp.start(); else mcp.stop(); updateTray(); } catch (e) { mcp.stop(); updateTray(); dialog.showErrorBox('MCP 启动失败', e.message); } } }, { label: '复制 MCP 连接配置', enabled: !!mcp.config(), click: () => { clipboard.writeText(JSON.stringify(mcp.config(), null, 2)); } }] : []),
    { type: 'separator' }, { label: '退出剪剪', click: () => { quitting = true; app.quit(); } }
  ]));
}
function changeSession() {
  sessionGeneration++; connected = false; mcp.cancel(); downloads.clear();
  for (const controller of floatingRequests) controller.abort();
  floatingRequests.clear();
}
function clearSession() {
  engine.stop(); changeSession(); current = null; vault.session = null; prefs = defaults();
  floating?.destroy(); persist(); updateTray();
}
function showFloating() {
  if (!floating) throw new Error('此设备暂不支持悬浮窗');
  if (!current) { show(); return false; }
  floating.show(); return true;
}
async function floatingApi(path, options = {}) {
  if (!current) throw new Error('请先在主界面登录');
  const requestSession = current, generation = sessionGeneration, controller = new AbortController();
  floatingRequests.add(controller);
  const timer = setTimeout(() => controller.abort(), 15000);
  const stale = () => generation !== sessionGeneration || current !== requestSession;
  try {
    const response = await fetch(`${requestSession.server}/api${path}`, { ...options, signal: controller.signal,
      headers: { Authorization: `Bearer ${requestSession.token}`, 'Content-Type': 'application/json' } });
    if (stale()) throw new Error('账号已切换，请重试');
    if (response.status === 401) { emit({ type: 'auth' }); throw new Error('登录已失效，请重新登录'); }
    const result = await response.json();
    if (stale()) throw new Error('账号已切换，请重试');
    if (!response.ok) throw new Error(result.error || '操作失败，请重试');
    return result;
  } catch (error) {
    if (stale()) throw new Error('账号已切换，请重试');
    if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('连接中断，请检查网络后重试');
    throw error;
  } finally { clearTimeout(timer); floatingRequests.delete(controller); }
}
function createWindow() {
  window = new BrowserWindow({ width: 1200, height: 850, minWidth: 760, minHeight: 580, title: '剪剪', backgroundColor: '#f6f8f5', icon: join(__dirname, 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, spellcheck: false } });
  window.loadFile(join(__dirname, '..', 'web', 'index.html'));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== page) event.preventDefault(); });
  window.on('close', event => { if (!quitting && tray) { event.preventDefault(); window.hide(); } });
}
async function download(value) {
  if (!current || !/^[0-9a-f-]{36}$/.test(value?.id)) throw new Error('文件标识无效');
  const downloadSession = current, generation = sessionGeneration;
  const active = () => current === downloadSession && generation === sessionGeneration;
  const result = await dialog.showSaveDialog(window, { defaultPath: basename(String(value.filename || 'download').replaceAll('\\', '/')) });
  if (result.canceled || !result.filePath || !active()) return { canceled: true };
  const task = downloads.start({ session: downloadSession, fileId: value.id, filename: basename(result.filePath), target: result.filePath, active });
  return { started: true, id: task.id };

}
app.whenReady().then(() => {
  if (!locked) return;
  loadVault();
  electronSession.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
  createWindow();
  if (process.platform === 'win32') floating = createFloatingController({ app, BrowserWindow, screen, isQuitting: () => quitting, onVisibility: updateTray });
  const icon = nativeImage.createFromPath(join(__dirname, 'icon.png'));
  tray = new Tray(icon.resize({ width: 20, height: 20 })); tray.setToolTip('剪剪 · 设备同步'); tray.on('click', show);
  updateTray();
  ipcMain.handle('jianjian', async (event, method, value) => {
    const mainSender = window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url === page;
    const floatWindow = floating?.window;
    const floatSender = floatWindow && !floatWindow.isDestroyed() && event.sender === floatWindow.webContents && event.senderFrame === floatWindow.webContents.mainFrame && event.senderFrame?.url === floating.page;
    const mainMethods = new Set(['getState', 'saveSession', 'connect', 'prefs', 'copy', 'readClipboard', 'download', 'listDownloads', 'cancelDownload', 'logout', 'showFloating']);
    const floatMethods = new Set(['floatingState', 'floatingList', 'floatingSend', 'copy', 'floatingHide', 'showMain']);
    if (!(mainSender && mainMethods.has(method)) && !(floatSender && floatMethods.has(method))) throw new Error('拒绝非本地页面操作');
    switch (method) {
      case 'getState': return { session: current, prefs, info: { platform: { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform], name: hostname(), clipboard: true, autoSendSupported: !wayland, floatingWindow: !!floating,
        capability: `桌面端支持文字剪贴板收发。关闭窗口后继续在托盘运行。${canEncrypt() ? '' : '系统密钥环不可用，登录仅在本次运行中保留。'}${wayland ? ' 当前检测到 Wayland，后台自动读取未启用，请使用手动发送剪贴板。' : ''}` } };
      case 'saveSession': {
        const next = validSession(value);
        engine.stop(); changeSession(); floating?.destroy(); current = next; vault.session = current;
        prefs = { ...defaults(), ...vault.accounts[key()] }; persist(); updateTray(); emit({ type: 'session' }); engine.start(current); return true;
      }
      case 'connect': if (!current) throw new Error('请先登录'); engine.start(current); return true;
      case 'showFloating': return showFloating();
      case 'floatingState': return { session: current ? { username: current.username, deviceId: current.deviceId } : null, connected, info: { name: hostname(), platform: 'Windows' } };
      case 'floatingList': return floatingApi('/messages?limit=50');
      case 'floatingSend': {
        if (typeof value?.text !== 'string' || !value.text.trim() || value.text.length > 32768 || !/^[a-zA-Z0-9-]{16,80}$/.test(value.clientId || '')) throw new Error('文字需为 1–32768 字符，且消息标识有效');
        const generation = sessionGeneration, requestSession = current;
        const item = await floatingApi('/messages', { method: 'POST', body: JSON.stringify({ kind: 'text', text: value.text, clientId: value.clientId }) });
        if (generation !== sessionGeneration || requestSession !== current) throw new Error('账号已切换，请重试');
        emit({ type: 'message', data: item }); return item;
      }
      case 'floatingHide': floating.hide(); return true;
      case 'showMain': {
        const id = value?.messageId;
        if (id !== undefined && (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id))) throw new Error('消息标识无效');
        show();
        if (id) {
          const generation = sessionGeneration;
          const notify = () => { if (generation === sessionGeneration && current && window && !window.isDestroyed()) window.webContents.send('jianjian:event', { type: 'focusMessage', id }); };
          if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', notify); else notify();
        }
        return true;
      }
      case 'prefs': {
        if (!current) throw new Error('请先登录');
        const next = Object.fromEntries(Object.keys(defaults()).map(k => [k, !!value?.[k]]));
        if (wayland) next.autoSend = false;
        if (next.autoStart !== prefs.autoStart) {
          if (process.platform === 'linux') {
            const path = join(app.getPath('home'), '.config', 'autostart', 'jianjian.desktop');
            if (next.autoStart) {
              const exec = process.env.APPIMAGE || app.getPath('exe');
              if (!app.isPackaged) throw new Error('请安装打包后的客户端，再设置开机启动');
              mkdirSync(join(app.getPath('home'), '.config', 'autostart'), { recursive: true });
              writeFileSync(path, `[Desktop Entry]\nType=Application\nName=Jianjian\nExec="${exec.replace(/["`$\\]/g, '\\$&')}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
            } else await unlink(path).catch(e => { if (e.code !== 'ENOENT') throw e; });
          } else {
            if (next.autoStart && !app.isPackaged) throw new Error('请安装打包后的客户端，再设置开机启动');
            app.setLoginItemSettings({ openAtLogin: next.autoStart, path: process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe'), args: ['--hidden'] });
          }
        }
        prefs = next; vault.accounts[key()] = prefs; persist(); return prefs;
      }
      case 'copy': if (!current) throw new Error('请先登录'); if (typeof value !== 'string' || value.length > 32768) throw new Error('文字过长'); engine.copy(value); return true;
      case 'readClipboard': return clipboard.readText().slice(0, 32768);
      case 'download': return download(value);
      case 'listDownloads': return downloads.list();
      case 'cancelDownload': downloads.cancel(value?.id); return true;
      case 'logout': clearSession(); return true;
      default: throw new Error('不支持的操作');
    }
  });
  // Reconnect independently of the main renderer's initial /me request.
  if (current) engine.start(current);
  if (current && floating?.enabled) floating.show();
  if (process.argv.includes('--hidden')) window.hide();
});
app.on('second-instance', show);
app.on('before-quit', () => { quitting = true; mcp.stop(); floating?.persist(); engine.stop(); changeSession(); });
app.on('window-all-closed', () => { if (quitting) app.quit(); });
app.on('activate', show);
