const { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

function fitBounds(saved, workArea) {
  const width = Math.min(workArea.width, Math.max(300, Math.round(Number(saved?.width) || 360)));
  const height = Math.min(workArea.height, Math.max(360, Math.round(Number(saved?.height) || 520)));
  const x = Number.isFinite(saved?.x) ? Math.round(saved.x) : workArea.x + workArea.width - width - 24;
  const y = Number.isFinite(saved?.y) ? Math.round(saved.y) : workArea.y + 48;
  return { x: Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - height), width, height };
}

function createFloatingController({ app, BrowserWindow, screen, isQuitting, onVisibility }) {
  let window = null, saveTimer, wanted = false;
  const file = join(app.getPath('userData'), 'floating-window.json');
  let settings = {};
  try { if (existsSync(file)) settings = JSON.parse(readFileSync(file, 'utf8')); } catch {}
  if (!settings || typeof settings !== 'object') settings = {};
  const page = pathToFileURL(join(__dirname, 'floating.html')).href;
  function persist() {
    clearTimeout(saveTimer);
    if (window && !window.isDestroyed()) settings.bounds = window.getNormalBounds();
    try {
      mkdirSync(app.getPath('userData'), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(settings)); renameSync(`${file}.tmp`, file);
    } catch {} // Window placement is optional; failure must not stop message sync.
  }
  function bounds() {
    const candidate = settings.bounds;
    const valid = ['x', 'y', 'width', 'height'].every(k => Number.isFinite(candidate?.[k]) && Math.abs(candidate[k]) < 1000000);
    const saved = valid ? candidate : null;
    const rectangle = valid ? { x: Math.round(saved.x), y: Math.round(saved.y), width: Math.max(1, Math.round(saved.width)), height: Math.max(1, Math.round(saved.height)) } : null;
    const display = rectangle ? screen.getDisplayMatching(rectangle) : screen.getPrimaryDisplay();
    return fitBounds(saved, display.workArea);
  }
  function show() {
    wanted = true; settings.enabled = true;
    if (window && !window.isDestroyed()) {
      window.setBounds(bounds()); window.show(); window.focus(); persist(); onVisibility(); return;
    }
    window = new BrowserWindow({ ...bounds(), minWidth: 300, minHeight: 360, title: '剪剪 · 悬浮窗',
      frame: false, show: false, resizable: true, maximizable: false, minimizable: false,
      fullscreenable: false, alwaysOnTop: true, skipTaskbar: true, backgroundColor: '#ededed',
      icon: join(__dirname, 'icon.png'), autoHideMenuBar: true,
      webPreferences: { preload: join(__dirname, 'floating-preload.cjs'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, backgroundThrottling: false, spellcheck: false } });
    const created = window;
    created.setAlwaysOnTop(true, 'floating');
    created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    created.webContents.on('will-navigate', (event, url) => { if (url !== page) event.preventDefault(); });
    created.once('ready-to-show', () => { if (wanted && !created.isDestroyed()) { created.show(); created.focus(); } });
    for (const event of ['move', 'resize']) created.on(event, () => { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 250); });
    created.on('close', event => {
      persist();
      if (!isQuitting()) { event.preventDefault(); hide(); }
    });
    created.on('closed', () => { if (window === created) window = null; });
    created.loadFile(join(__dirname, 'floating.html'));
    persist(); onVisibility();
  }
  function hide() {
    wanted = false; settings.enabled = false; persist();
    if (window && !window.isDestroyed()) window.hide();
    onVisibility();
  }
  function destroy() {
    wanted = false; settings.enabled = false; persist();
    if (window && !window.isDestroyed()) window.destroy();
    window = null; onVisibility();
  }
  function reposition() {
    if (window && !window.isDestroyed()) { settings.bounds = window.getNormalBounds(); window.setBounds(bounds()); persist(); }
  }
  screen.on('display-removed', reposition); screen.on('display-metrics-changed', reposition);
  return { get window() { return window; }, page, show, hide, destroy, persist,
    get enabled() { return settings.enabled === true; }, get visible() { return wanted; } };
}
module.exports = { createFloatingController, fitBounds };
