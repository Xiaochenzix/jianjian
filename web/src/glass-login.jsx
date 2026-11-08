import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';

function readDraft() {
  const value = id => document.getElementById(id)?.value || '';
  return { server: value('server-input'), username: value('username-input'), device: value('device-input') };
}

function GlassLogin() {
  const initial = readDraft();
  const [server, setServer] = useState(initial.server);
  const [username, setUsername] = useState(initial.username);
  const [password, setPassword] = useState('');
  const [device, setDevice] = useState(initial.device);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shake, setShake] = useState(false);
  const [status, setStatus] = useState('正在确认节点');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const onLogin = event => {
      const phase = event.detail?.phase;
      if (phase === 'start') { setBusy(true); setError(''); return; }
      setBusy(false);
      if (phase === 'error') { setError(event.detail.message || '登录失败'); setShake(true); }
    };
    const onSync = () => {
      const draft = readDraft();
      setServer(draft.server); setUsername(draft.username); setDevice(draft.device);
    };
    document.addEventListener('jianjian-login', onLogin);
    document.getElementById('glass-login')?.addEventListener('glass-sync', onSync);
    return () => {
      document.removeEventListener('jianjian-login', onLogin);
      document.getElementById('glass-login')?.removeEventListener('glass-sync', onSync);
    };
  }, []);

  useEffect(() => {
    if (!shake) return undefined;
    const timer = setTimeout(() => setShake(false), 460);
    return () => clearTimeout(timer);
  }, [shake]);

  useEffect(() => {
    const address = server.trim();
    if (!address) { setStatus('尚未填写服务器'); setReady(false); return undefined; }
    let origin = '';
    try { origin = new URL(address).origin; }
    catch { setStatus('服务器地址无法识别'); setReady(false); return undefined; }
    const secure = origin.startsWith('https:');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const started = performance.now();
    setStatus('正在确认节点');
    fetch(`${origin}/api/health`, { signal: controller.signal })
      .then(response => {
        const ms = Math.max(1, Math.round(performance.now() - started));
        if (!response.ok) { setReady(false); setStatus('节点未响应'); return; }
        setReady(true);
        setStatus(`${ms} ms · ${secure ? 'HTTPS' : '本地连接'} · 私有节点就绪`);
      })
      .catch(error => { if (error?.name === 'AbortError') return; setReady(false); setStatus('节点未响应'); })
      .finally(() => clearTimeout(timer));
    return () => { controller.abort(); clearTimeout(timer); };
  }, [server]);

  function fail(message) { setError(message); setShake(true); }

  function submit(event) {
    event.preventDefault();
    if (busy) return;
    if (!server.trim() || !username.trim() || !password || !device.trim()) { fail('请填写服务器、账号、密码和设备名称'); return; }
    const serverInput = document.getElementById('server-input');
    const usernameInput = document.getElementById('username-input');
    const passwordInput = document.getElementById('password-input');
    const deviceInput = document.getElementById('device-input');
    const form = document.getElementById('login-form');
    serverInput.value = server.trim();
    usernameInput.value = username.trim();
    passwordInput.value = password;
    deviceInput.value = device.trim();
    serverInput.dispatchEvent(new Event('input', { bubbles: true }));
    form.dataset.mode = 'password';
    form.requestSubmit();
  }

  return (
    <div className="glass-root relative flex items-center justify-center overflow-hidden bg-gradient-to-br from-[#10283a] via-[#3f6f7c] to-[#d7e6e2] px-5 pt-[max(1.75rem,var(--safe-top))] pb-[max(1.75rem,var(--safe-bottom))] text-[#10212b]">
      <div className="pointer-events-none absolute -left-16 top-[-4rem] size-[28rem] rounded-full bg-cyan-300/70 blur-3xl" />
      <div className="pointer-events-none absolute right-[-6rem] top-1/4 size-[26rem] rounded-full bg-indigo-400/50 blur-3xl" />
      <div className="pointer-events-none absolute bottom-[-5rem] left-1/4 size-[24rem] rounded-full bg-emerald-200/70 blur-3xl" />
      <form onSubmit={submit} className={`relative w-full max-w-md rounded-3xl border border-white/40 bg-white/20 px-7 py-8 shadow-2xl backdrop-blur-2xl dark:border-white/15 dark:bg-black/30 dark:text-white ${shake ? 'animate-glass-shake' : ''}`}>
        <div className="mb-6 flex flex-col items-center text-center">
          <img src="icon.svg" alt="" className="mb-4 size-14 rounded-[22px] shadow-lg" />
          <h1 className="text-[22px] font-semibold tracking-tight">接入你的剪剪私有云</h1>
          <p className="mt-1.5 text-[13px] text-slate-700/80 dark:text-white/70">只在你自己的设备之间同步</p>
        </div>
        <div className="overflow-hidden rounded-2xl border border-white/40 bg-white/35 dark:border-white/10 dark:bg-white/10">
          <label className="block border-b border-white/40 px-3.5 py-2.5 dark:border-white/10">
            <span className="mb-0.5 block text-[11px] text-slate-600 dark:text-white/60">服务器</span>
            <input value={server} onChange={event => setServer(event.target.value)} inputMode="url" autoComplete="url" spellCheck="false" placeholder="https://地址:端口" className="w-full bg-transparent text-[16px] outline-none placeholder:text-slate-500/70" />
          </label>
          <label className="block border-b border-white/40 px-3.5 py-2.5 dark:border-white/10">
            <span className="mb-0.5 block text-[11px] text-slate-600 dark:text-white/60">设备名称</span>
            <input value={device} onChange={event => setDevice(event.target.value)} maxLength={64} autoComplete="off" placeholder="在其他设备上显示的名字" className="w-full bg-transparent text-[16px] outline-none placeholder:text-slate-500/70" />
          </label>
          <label className="block border-b border-white/40 px-3.5 py-2.5 dark:border-white/10">
            <span className="mb-0.5 block text-[11px] text-slate-600 dark:text-white/60">账号</span>
            <input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck="false" placeholder="账号" className="w-full bg-transparent text-[16px] outline-none placeholder:text-slate-500/70" />
          </label>
          <label className="relative block px-3.5 py-2.5">
            <span className="mb-0.5 block text-[11px] text-slate-600 dark:text-white/60">密码</span>
            <input value={password} onChange={event => setPassword(event.target.value)} type="password" autoComplete="current-password" placeholder="密码" className="w-full bg-transparent pr-12 text-[16px] outline-none placeholder:text-slate-500/70" />
            <button type="submit" aria-label="登录" disabled={busy} className="absolute right-2.5 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full bg-[#10212b] text-white shadow-md transition hover:brightness-125 disabled:opacity-60 dark:bg-white dark:text-[#10212b]">
              {busy ? <Spinner /> : <Arrow />}
            </button>
          </label>
        </div>
        <p role="alert" className={`min-h-5 pt-3 text-center text-[12px] text-rose-700 dark:text-rose-300 ${error ? '' : 'invisible'}`}>{error || ' '}</p>
        <p className="mx-auto mt-2 flex w-fit items-center gap-2 rounded-full bg-white/35 px-3 py-1 text-[11px] text-slate-700 backdrop-blur-md dark:bg-white/10 dark:text-white/75">
          <i className={`size-1.5 rounded-full ${ready ? 'bg-emerald-500' : 'bg-amber-400'}`} />
          {status}
        </p>
      </form>
    </div>
  );
}

function Arrow() {
  return <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
}

function Spinner() {
  return <svg viewBox="0 0 24 24" className="size-4 animate-spin" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.4" /><path d="M20 12a8 8 0 0 0-8-8" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>;
}

function mountGlassLogin() {
  const host = document.getElementById('glass-login');
  if (!host) return;
  if (host.dataset.ready === '1') { host.dispatchEvent(new CustomEvent('glass-sync')); return; }
  host.dataset.ready = '1';
  const shadow = host.attachShadow({ mode: 'open' });
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'glass-login.css';
  const mount = document.createElement('div');
  mount.style.height = '100%';
  shadow.append(link, mount);
  createRoot(mount).render(<GlassLogin />);
}

window.__mountGlassLogin = mountGlassLogin;
