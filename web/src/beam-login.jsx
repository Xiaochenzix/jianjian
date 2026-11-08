import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Check, Clipboard, Copy, Eye, EyeOff, FileArchive, Folder, Globe, Link, Lock, Monitor, Scissors, Server, Smartphone, User } from 'lucide-react';

const spring = { type: 'spring', stiffness: 260, damping: 20 };
const springLoop = { type: 'spring', stiffness: 260, damping: 20, repeat: Infinity, repeatType: 'loop' };
const fieldClass = 'w-full bg-zinc-950/90 border border-white/10 rounded-xl py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20 outline-none transition-all';

const scenes = [
  { key: 'clip', action: '已复制文本', packet: Clipboard, badge: '来自 Android 剪贴板 · 刚刚', body: 'clip' },
  { key: 'link', action: '发送链接', packet: Link, badge: '来自 Android 浏览器 · 刚刚', body: 'link' },
  { key: 'file', action: '发送文件', packet: FileArchive, badge: '来自 Android 文件 · 刚刚', body: 'file' },
];
const flight = { duration: 0.45, ease: [0.4, 0, 1, 1] };

const rise = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: spring },
};

function readDraft() {
  const value = id => document.getElementById(id)?.value || '';
  return { server: value('server-input'), username: value('username-input'), device: value('device-input') };
}

function BeamLogin() {
  const reduce = useReducedMotion();
  const initial = readDraft();
  const [server, setServer] = useState(initial.server);
  const [username, setUsername] = useState(initial.username);
  const [password, setPassword] = useState('');
  const [device, setDevice] = useState(initial.device);
  const [showPassword, setShowPassword] = useState(false);
  const [nodeOpen, setNodeOpen] = useState(false);
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState('');
  const [latency, setLatency] = useState(18);
  const [online, setOnline] = useState(Boolean(initial.server.trim()));
  const [items, setItems] = useState([]);
  const [scene, setScene] = useState(0);
  const [step, setStep] = useState('send');
  const attempted = useRef(false);

  useEffect(() => {
    const onLogin = event => {
      const next = event.detail?.phase;
      if (next === 'start') { setPhase('loading'); setError(''); return; }
      if (next === 'ok') { setPhase('success'); return; }
      if (!attempted.current) return;
      setPhase('error');
      setError(event.detail?.message || '登录失败');
    };
    const onSync = () => {
      const draft = readDraft();
      setServer(draft.server);
      setUsername(draft.username);
      setDevice(draft.device);
      setOnline(Boolean(draft.server.trim()));
    };
    document.addEventListener('jianjian-login', onLogin);
    document.getElementById('beam-login')?.addEventListener('beam-sync', onSync);
    return () => {
      document.removeEventListener('jianjian-login', onLogin);
      document.getElementById('beam-login')?.removeEventListener('beam-sync', onSync);
    };
  }, []);

  useEffect(() => {
    if (reduce) {
      setItems(scenes.map((item, index) => ({ id: index + 1, card: index })));
      setStep('arrive');
      return undefined;
    }
    let alive = true;
    const timers = [];
    const wait = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timers.push(timer); });
    let index = 0;
    let nextId = 1;
    (async () => {
      while (alive) {
        setScene(index);
        setStep('send');
        await wait(560);
        if (!alive) return;
        setStep('to-server');
        await wait(450);
        if (!alive) return;
        setStep('store');
        await wait(180);
        if (!alive) return;
        setStep('to-target');
        await wait(450);
        if (!alive) return;
        setStep('arrive');
        const card = index;
        const id = nextId++;
        setItems(current => [...current, { id, card }].slice(-3));
        await wait(1860);
        if (!alive) return;
        index = (index + 1) % scenes.length;
      }
    })();
    return () => { alive = false; timers.forEach(clearTimeout); };
  }, [reduce]);

  useEffect(() => {
    if (!online) return undefined;
    const timer = setInterval(() => setLatency(current => Math.max(8, Math.min(36, current + Math.round((Math.random() - 0.45) * 5)))), 900);
    return () => clearInterval(timer);
  }, [online]);

  useEffect(() => {
    const address = server.trim();
    if (!address) { setOnline(false); return undefined; }
    let origin = '';
    try { origin = new URL(address).origin; } catch { setOnline(false); return undefined; }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const started = performance.now();
    fetch(`${origin}/api/health`, { signal: controller.signal })
      .then(response => {
        if (!response.ok) { setOnline(false); return; }
        setOnline(true);
        setLatency(Math.max(8, Math.round(performance.now() - started)));
      })
      .catch(error => { if (error?.name !== 'AbortError') setOnline(false); })
      .finally(() => clearTimeout(timer));
    return () => { controller.abort(); clearTimeout(timer); };
  }, [server]);

  function change(setter) {
    return event => { setter(event.target.value); setError(''); };
  }

  function submit(event) {
    event.preventDefault();
    if (phase === 'loading') return;
    attempted.current = true;
    if (!server.trim() || !username.trim() || !password || !device.trim()) {
      if (!server.trim()) setNodeOpen(true);
      setError('请填写服务器、账号、密码和设备名称');
      setPhase('error');
      return;
    }
    document.getElementById('server-input').value = server.trim();
    document.getElementById('username-input').value = username.trim();
    document.getElementById('password-input').value = password;
    document.getElementById('device-input').value = device.trim();
    document.getElementById('server-input').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('login-form').dataset.mode = 'password';
    setError('');
    setPhase('loading');
    document.getElementById('login-form').requestSubmit();
  }

  const statusLead = !server.trim() ? '填写私有节点地址' : online ? '私有节点已连接 · ' : '节点未响应';
  const showLatency = Boolean(server.trim() && online);
  const newest = items[items.length - 1]?.id;
  const stagger = reduce ? 0 : 0.08;

  return (
    <div className="beam-root relative flex h-screen w-screen select-none items-center justify-center overflow-hidden bg-[#09090b] text-zinc-100">
      <div className="pointer-events-none absolute top-0 h-[220px] w-[600px] bg-gradient-to-b from-zinc-200/[0.07] via-cyan-300/[0.03] to-transparent blur-[80px]" style={{ left: 'calc(50% - 300px)', backgroundImage: 'linear-gradient(to bottom, rgba(228,228,231,0.07), rgba(103,232,249,0.03), transparent)' }} />
      {depthCards.map(item => <DepthCard key={item.label} item={item} reduce={reduce} />)}
      <SyncArc reduce={reduce} />
      <motion.section className="relative z-10 grid w-[min(920px,calc(100%-2rem))] select-text grid-cols-1 overflow-hidden rounded-3xl border border-white/[0.08] bg-zinc-900/70 shadow-[0_24px_80px_rgba(0,0,0,0.9),inset_0_1px_0_0_rgba(255,255,255,0.12)] backdrop-blur-2xl md:grid-cols-12" initial="hidden" animate="show" variants={{ hidden: {}, show: { transition: { staggerChildren: stagger, ...spring } } }}>
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-12 top-0 z-20 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent" style={{ backgroundImage: 'linear-gradient(to right, transparent, rgba(255,255,255,0.25), transparent)' }} />
          <motion.form onSubmit={submit} variants={{ hidden: {}, show: { transition: { staggerChildren: stagger } } }} className="flex flex-col justify-center gap-8 border-b border-white/[0.06] p-8 md:col-span-5 md:border-b-0 md:border-r">
            <motion.div variants={rise} className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/15 bg-gradient-to-b from-zinc-800 to-zinc-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]" style={{ backgroundImage: 'linear-gradient(to bottom, #27272a, #09090b)' }}><Scissors size={16} className="text-emerald-400 drop-shadow-[0_0_6px_rgba(52,211,153,0.9)]" /></span>
              <span>
                <h1 className="text-[18px] font-semibold tracking-tight">剪剪</h1>
                <p className="text-[12px] text-zinc-400">私有跨端同步中心</p>
              </span>
            </motion.div>
            <div className="flex flex-col gap-3">
              <motion.div variants={rise}>
                <button type="button" onClick={() => setNodeOpen(open => !open)} aria-expanded={nodeOpen} className="flex w-full items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-2 text-left text-[12px] text-zinc-300">
                  <i className={`size-1.5 shrink-0 rounded-full ${online && server.trim() ? 'animate-pulse bg-emerald-400' : 'bg-amber-400'}`} />
                  <span>{statusLead}{showLatency && <span className="font-mono tabular-nums">{latency}ms</span>}</span>
                </button>
                <AnimatePresence initial={false}>
                  {nodeOpen && (
                    <motion.div key="server" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring} className="overflow-hidden">
                      <label className="mt-3 block text-[12px] text-zinc-400">服务器地址
                        <input value={server} onChange={change(setServer)} inputMode="url" autoComplete="url" spellCheck="false" placeholder="https://地址:端口" aria-label="服务器地址" className={`${fieldClass} mt-1.5 px-3.5`} />
                      </label>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
              <motion.label variants={rise} className="relative block">
                <span className="pointer-events-none absolute left-3 flex h-5 w-5 items-center justify-center text-zinc-500" style={{ top: '50%', transform: 'translateY(-50%)' }}><User size={15} /></span>
                <input value={username} onChange={change(setUsername)} autoComplete="username" autoCapitalize="none" spellCheck="false" placeholder="账号" aria-label="账号" className={`${fieldClass} px-3.5 pl-10`} />
              </motion.label>
              <motion.label variants={rise} className="relative block">
                <span className="pointer-events-none absolute left-3 flex h-5 w-5 items-center justify-center text-zinc-500" style={{ top: '50%', transform: 'translateY(-50%)' }}><Lock size={15} /></span>
                <input value={password} onChange={change(setPassword)} type={showPassword ? 'text' : 'password'} autoComplete="current-password" placeholder="密码" aria-label="密码" className={`${fieldClass} px-3.5 pl-10 pr-11`} />
                <button type="button" onClick={() => setShowPassword(shown => !shown)} aria-label={showPassword ? '隐藏密码' : '显示密码'} aria-pressed={showPassword} className="absolute right-2 flex size-8 items-center justify-center text-zinc-400" style={{ top: '50%', transform: 'translateY(-50%)' }}>
                  <motion.span animate={{ rotate: showPassword ? 180 : 0 }} transition={spring} className="flex items-center justify-center">{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</motion.span>
                </button>
              </motion.label>
              <motion.label variants={rise} className="relative block">
                <span className="pointer-events-none absolute left-3 flex h-5 w-5 items-center justify-center text-zinc-500" style={{ top: '50%', transform: 'translateY(-50%)' }}><Monitor size={15} /></span>
                <input value={device} onChange={change(setDevice)} maxLength={64} autoComplete="off" placeholder="如：我的 Windows 电脑" aria-label="设备名称" className={`${fieldClass} px-3.5 pl-10`} />
              </motion.label>
              <motion.div variants={rise}>
                <button type="submit" disabled={phase === 'loading'} className={`flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium shadow-sm transition-all ${phase === 'success' ? 'bg-emerald-500 text-white' : 'bg-zinc-100 text-zinc-950 hover:bg-white'}`}>
                  {phase === 'loading' ? <Ring /> : phase === 'success' ? <><motion.span initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring} className="grid place-items-center"><Check size={16} /></motion.span>已登录</> : '登录'}
                </button>
                <AnimatePresence initial={false}>
                  {attempted.current && error && (
                    <motion.div key="error" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={spring} className="overflow-hidden">
                      <p role="alert" className="mt-3 inline-flex rounded-full bg-amber-400/10 px-3 py-1.5 text-[12px] text-amber-200">{error}</p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            </div>
          </motion.form>
          <motion.aside variants={rise} className="relative flex flex-col justify-between bg-zinc-950/50 p-8 md:col-span-7">
            <DispatchTrack step={step} scene={scenes[scene]} reduce={reduce} />
            <div className="relative my-6 h-[332px] overflow-hidden">
              <div className="absolute inset-x-0 bottom-0 flex flex-col gap-3">
              <AnimatePresence mode="popLayout" initial={false}>
                {items.map(item => (
                  <StreamCard key={item.id} item={item} active={item.id === newest} />
                ))}
              </AnimatePresence>
              </div>
            </div>
            <p className="text-[11px] tracking-wide text-zinc-500">账号隔离 · 无公开注册 · 数据 100% 留存自建服务端</p>
          </motion.aside>
        </motion.section>
      <StatusCapsule reduce={reduce} />
    </div>
  );
}

const depthCards = [
  { label: '手机', icon: Smartphone, place: 'left-[max(12px,calc(50%-540px))] top-[20%]', depth: 'opacity-70', duration: 8 },
  { label: '剪贴板', icon: Clipboard, place: 'left-[max(28px,calc(50%-500px))] bottom-[18%]', depth: 'opacity-50', duration: 9.2 },
  { label: '文件夹', icon: Folder, place: 'right-[max(28px,calc(50%-500px))] top-[18%]', depth: 'opacity-50', duration: 7.4 },
  { label: '电脑', icon: Monitor, place: 'right-[max(12px,calc(50%-540px))] bottom-[20%]', depth: 'opacity-70', duration: 6.8 },
];

function DepthCard({ item, reduce }) {
  const Icon = item.icon;
  return (
    <motion.div aria-hidden="true" className={`pointer-events-none absolute z-0 hidden h-12 w-12 items-center justify-center rounded-2xl border border-white/[0.12] bg-zinc-900/60 text-zinc-400/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.15)] backdrop-blur-md md:flex ${item.place} ${item.depth}`} animate={reduce ? undefined : { y: [-12, 12, -12], rotate: [-4, 4, -4] }} transition={{ duration: item.duration, delay: item.duration / 5, repeat: Infinity, ease: 'easeInOut' }}>
      <Icon size={18} strokeWidth={1.5} />
    </motion.div>
  );
}

function SyncArc({ reduce }) {
  const arc = 'M 28 78 Q 500 8 972 318';
  return (
    <svg className="pointer-events-none absolute z-0 hidden md:block" style={{ left: 'max(12px, calc(50% - 540px))', right: 'max(12px, calc(50% - 540px))', top: '16%', bottom: '14%' }} viewBox="0 0 1000 400" preserveAspectRatio="none" aria-hidden="true">
      <path d={arc} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
      <motion.path d={arc} fill="none" stroke="rgba(186,230,253,0.45)" strokeWidth="1.5" strokeLinecap="round" strokeDasharray="16 220" vectorEffect="non-scaling-stroke" animate={reduce ? undefined : { strokeDashoffset: [0, -472] }} transition={{ duration: 8.5, repeat: Infinity, ease: 'linear' }} />
    </svg>
  );
}

function StatusCapsule({ reduce }) {
  return (
    <div className="pointer-events-none fixed bottom-6 inset-x-0 z-20 flex justify-center">
      <div className="flex items-center gap-3 rounded-full border border-white/[0.06] bg-zinc-900/80 px-4 py-1.5 text-xs text-zinc-500">
        <motion.i aria-hidden="true" className="size-1.5 rounded-full bg-zinc-400" animate={reduce ? { opacity: 0.7 } : { opacity: [0.35, 1, 0.35] }} transition={{ duration: 3.4, repeat: Infinity, ease: 'easeInOut' }} />
        <motion.span animate={reduce ? { opacity: 0.8 } : { opacity: [0.5, 1, 0.5] }} transition={{ duration: 4.8, repeat: Infinity, ease: 'easeInOut' }}>私有隔离 · 支持 Windows / Android / Web</motion.span>
      </div>
    </div>
  );
}

function DispatchTrack({ step, scene, reduce }) {
  const PacketIcon = scene.packet;
  const place = step === 'to-server' || step === 'store' ? '46%' : step === 'to-target' || step === 'arrive' ? '84%' : '8%';
  const moving = step === 'to-server' || step === 'to-target';
  const visible = step !== 'send';
  return (
    <div>
      <div className="mb-5 flex items-center justify-between text-[12px] text-zinc-400">
        <span>剪剪实时同步流</span>
        <span className="inline-flex items-center gap-1.5 text-emerald-300"><i className="size-1.5 animate-pulse rounded-full bg-emerald-400" />实时</span>
      </div>
      <div className="relative mt-6">
        <div className="flex items-center gap-2">
          <TrackNode icon={Smartphone} label="Android 手机" hot={step === 'send' || step === 'to-server'} bubble={step === 'send' ? scene.action : ''} />
          <span className="h-px min-w-6 flex-1 bg-white/10" />
          <TrackNode icon={Server} label="私有服务端" hot={step === 'store'} pulse={step === 'store'} />
          <span className="h-px min-w-6 flex-1 bg-white/10" />
          <TrackNode icon={Monitor} label="Windows 本机" hot={step === 'arrive'} flash={step === 'arrive'} />
        </div>
        <motion.span key={scene.key} aria-hidden="true" className="absolute top-0 z-10" initial={{ left: '8%', opacity: 0 }} animate={{ left: place, opacity: visible ? 1 : 0 }} transition={moving && !reduce ? flight : { duration: reduce ? 0 : 0.16 }}>
          <span className="relative flex -translate-x-1/2 items-center">
            <i className="absolute right-2 h-2 w-12 rounded-full bg-gradient-to-r from-transparent via-cyan-100/30 to-emerald-300/80 blur-[1px]" style={{ backgroundImage: 'linear-gradient(to right, transparent, rgba(224,242,254,0.25), rgba(110,231,183,0.9))' }} />
            <span className="relative grid size-6 place-items-center rounded-full border border-emerald-300/50 bg-zinc-950 text-emerald-100 shadow-[0_0_16px_rgba(16,185,129,0.65)]"><PacketIcon size={12} /></span>
          </span>
        </motion.span>
      </div>
    </div>
  );
}

function TrackNode({ icon: Icon, label, hot, bubble = '', pulse = false, flash = false }) {
  return (
    <div className="relative">
      {bubble && (
        <span className="absolute -top-7 whitespace-nowrap" style={{ left: '50%', transform: 'translateX(-50%)' }}>
          <motion.span initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="block whitespace-nowrap rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] text-emerald-100">{bubble}</motion.span>
        </span>
      )}
      <motion.span animate={pulse ? { scale: [1, 1.14, 1] } : flash ? { boxShadow: ['0 0 0 rgba(255,255,255,0)', '0 0 18px rgba(255,255,255,0.9)', '0 0 0 rgba(255,255,255,0)'] } : { scale: 1, boxShadow: hot ? '0 0 16px rgba(16,185,129,0.45)' : '0 0 0 rgba(0,0,0,0)' }} transition={{ duration: pulse || flash ? 0.45 : 0.2 }} className={`relative inline-flex items-center gap-1.5 rounded-full border bg-zinc-950/80 px-2.5 py-1 text-[11px] text-zinc-200 ${hot ? 'border-emerald-400/80' : 'border-white/10'}`}>
        {hot && <i aria-hidden="true" className="absolute -inset-1 animate-pulse rounded-full border border-emerald-400/50" />}
        <Icon size={12} className={hot ? 'text-emerald-200' : 'text-zinc-400'} />
        {label}
      </motion.span>
    </div>
  );
}

function StreamCard({ item, active }) {
  const preview = scenes[item.card];
  return (
    <motion.article layout initial={{ opacity: 0, y: 42, scale: 0.98 }} animate={{ opacity: active ? 1 : 0.58, y: 0, scale: 1 }} exit={{ opacity: 0, y: -28, scale: 0.98 }} transition={spring} className={`relative overflow-hidden rounded-2xl border p-3.5 pl-4 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12)] backdrop-blur-xl ${active ? 'border-emerald-500/30 bg-zinc-900/95' : 'border-white/10 bg-white/[0.04]'}`}>
      {active && <motion.i aria-hidden="true" className="absolute bottom-3 left-1.5 top-3 w-0.5 rounded-full bg-emerald-400" animate={{ opacity: [0.45, 1, 0.45] }} transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }} />}
      <p className="text-[11px] text-zinc-500">{preview.badge}</p>
      {preview.body === 'clip' ? <ClipBody /> : preview.body === 'link' ? <LinkBody /> : <FileBody fresh={active} />}
    </motion.article>
  );
}

function ClipBody() {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="mt-2 flex items-center gap-2 rounded-xl border border-white/10 bg-zinc-950/80 px-3 py-2">
      <code className="min-w-0 flex-1 truncate font-mono text-[13px] tabular-nums text-emerald-100">docker compose up -d</code>
      <button type="button" onClick={() => { const done = () => setCopied(true); const pending = navigator.clipboard?.writeText('docker compose up -d'); if (pending) pending.then(done, done); else done(); }} className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/10" aria-label="复制命令">
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  );
}

function LinkBody() {
  return (
    <div className="mt-2 flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] p-2.5">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-cyan-400/10 text-cyan-200"><Globe size={16} /></span>
      <span className="min-w-0">
        <strong className="block truncate text-[13px] font-medium text-zinc-100">私有节点部署说明</strong>
        <small className="mt-0.5 block truncate text-[11px] text-zinc-500">https://…/deploy</small>
      </span>
    </div>
  );
}

function FileBody({ fresh }) {
  const [pct, setPct] = useState(fresh ? 0 : 100);
  useEffect(() => {
    if (!fresh) { setPct(100); return undefined; }
    setPct(0);
    const start = performance.now();
    let frame = 0;
    const tick = now => {
      const next = Math.min(100, Math.round((now - start) / 720 * 100));
      setPct(next);
      if (next < 100) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [fresh]);
  return (
    <div className="mt-2">
      <div className="flex items-center gap-2 text-[13px] text-zinc-100">
        <FileArchive size={15} className="text-emerald-300" />
        <span className="min-w-0 flex-1 truncate font-mono tabular-nums">release-v1.2.apk · 24.8 MB</span>
        <span className="font-mono text-[11px] tabular-nums text-emerald-300">{pct}%</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
        <span className="block h-full rounded-full bg-emerald-400" style={{ width: `${pct}%` }} />
      </div>
      <AnimatePresence>
        {pct === 100 && <motion.p initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring} className="mt-1.5 text-[11px] text-emerald-300">✓ 已落盘至私有服务器</motion.p>}
      </AnimatePresence>
    </div>
  );
}

function Ring() {
  return (
    <motion.svg viewBox="0 0 24 24" className="size-4 text-zinc-950" animate={{ rotate: 360 }} transition={springLoop} aria-hidden="true">
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.4" />
      <motion.circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeDasharray="12 40" animate={{ strokeDashoffset: [0, -52] }} transition={springLoop} />
    </motion.svg>
  );
}

function mountBeamLogin() {
  const host = document.getElementById('beam-login');
  if (!host) return;
  if (host.dataset.ready === '1') { host.dispatchEvent(new CustomEvent('beam-sync')); return; }
  host.dataset.ready = '1';
  const shadow = host.attachShadow({ mode: 'open' });
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'beam-login.css';
  const mount = document.createElement('div');
  mount.style.height = '100%';
  shadow.append(link, mount);
  createRoot(mount).render(<BeamLogin />);
}

window.__mountBeamLogin = mountBeamLogin;
