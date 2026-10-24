const { randomUUID } = require('node:crypto');
class SyncEngine {
  constructor({ clipboard, emit, getPrefs, fetchImpl = fetch }) {
    this.clipboard = clipboard; this.emit = emit; this.getPrefs = getPrefs; this.fetch = fetchImpl;
    this.session = null; this.lastText = ''; this.pending = null; this.sending = false; this.generation = 0;
    this.connected = false; this.connection = null; this.sendTask = null;
    this.pollTimer = null; this.reconnectTimer = null; this.controller = null;
  }
  start(session) {
    if (this.session && ['server', 'token', 'deviceId'].every(key => this.session[key] === session[key])) {
      // A second renderer or a reloaded page can subscribe without replacing the stream.
      this.emitStatus(); return false;
    }
    this.stop(); this.session = { ...session }; this.lastText = this.clipboard.readText();
    const generation = this.generation, current = this.session;
    this.pollTimer = setInterval(() => {
      if (this.isCurrent(generation, current)) this.poll().catch(() => {});
    }, 900);
    this.pollTimer.unref?.();
    this.emitStatus();
    this.connect(generation);
    return true;
  }
  stop() {
    this.generation++;
    const connection = this.connection, sendTask = this.sendTask;
    this.connection = null; this.sendTask = null; this.controller = null;
    this.session = null; this.pending = null; this.sending = false; this.connected = false;
    clearInterval(this.pollTimer); clearTimeout(this.reconnectTimer);
    this.pollTimer = null; this.reconnectTimer = null;
    connection?.controller.abort(); sendTask?.controller.abort();
    this.cancelReader(connection?.reader);
  }
  isCurrent(generation, session) {
    return !!session && generation === this.generation && session === this.session;
  }
  emitStatus() {
    this.emit({ type: 'status', connected: this.connected, detail: this.connected ? '已连接 · 实时同步' : this.reconnectTimer ? '连接中断 · 正在重连' : '正在连接' });
  }
  cancelReader(reader) {
    if (!reader) return;
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
  }
  cancelResponse(response) {
    if (!response?.body) return;
    try { Promise.resolve(response.body.cancel()).catch(() => {}); } catch {}
  }
  copy(text) {
    this.pending = null; this.lastText = text; this.clipboard.writeText(text);
  }
  async poll() {
    if (!this.session) return;
    if (!this.getPrefs().autoSend) { this.lastText = this.clipboard.readText(); this.pending = null; return; }
    const text = this.clipboard.readText();
    if (text !== this.lastText) {
      this.lastText = text;
      if (text.trim() && text.length <= 32768) this.pending = { text, kind: 'clipboard', clientId: randomUUID() };
    }
    if (!this.pending || this.sending) return;
    const pending = this.pending, session = this.session, generation = this.generation;
    const task = { controller: new AbortController() }; this.sendTask = task; this.sending = true;
    try {
      const signal = AbortSignal.any([task.controller.signal, AbortSignal.timeout(15000)]);
      const res = await this.fetch(`${session.server}/api/messages`, { method: 'POST', signal, headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(pending) });
      if (!this.isCurrent(generation, session) || task.controller.signal.aborted) { this.cancelResponse(res); return; }
      if (res.ok && this.pending === pending) this.pending = null;
      if (res.status === 401) { this.stop(); this.emit({ type: 'auth' }); }
      this.cancelResponse(res);
    } catch {} finally {
      // A previous account's completion must not release the next account's send lock.
      if (this.sendTask === task) { this.sendTask = null; this.sending = false; }
    }
  }
  receive(type, data, generation = this.generation, session = this.session) {
    if (!this.isCurrent(generation, session)) return;
    if (type === 'message' && ['clipboard', 'text'].includes(data.kind) && data.device_id !== session.deviceId && this.getPrefs().autoWrite) this.copy(data.text);
    this.emit({ type, data });
  }
  async connect(generation) {
    const session = this.session;
    if (!this.isCurrent(generation, session) || this.connection) return;
    const task = { controller: new AbortController(), reader: null };
    this.connection = task; this.controller = task.controller;
    const active = () => this.isCurrent(generation, session) && this.connection === task && !task.controller.signal.aborted;
    try {
      const res = await this.fetch(`${session.server}/api/events`, { headers: { Authorization: `Bearer ${session.token}` }, signal: task.controller.signal });
      if (!active()) { this.cancelResponse(res); return; }
      if (res.status === 401) { this.cancelResponse(res); this.stop(); this.emit({ type: 'auth' }); return; }
      if (!res.ok) { this.cancelResponse(res); throw new Error('连接失败'); }
      task.reader = res.body.getReader();
      this.connected = true; this.emitStatus();
      const decoder = new TextDecoder(); let buffer = '';
      while (active()) {
        const { done, value } = await task.reader.read();
        if (!active() || done) break;
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
        let index;
        while (active() && (index = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          const type = /^event: (.+)$/m.exec(block)?.[1]; const data = /^data: (.+)$/m.exec(block)?.[1];
          if (type) this.receive(type, data ? JSON.parse(data) : {}, generation, session);
        }
      }
    } catch {} finally {
      this.cancelReader(task.reader);
      try { task.reader?.releaseLock(); } catch {}
      if (this.connection === task) { this.connection = null; this.controller = null; }
    }
    if (!this.isCurrent(generation, session) || task.controller.signal.aborted) return;
    this.connected = false;
    clearTimeout(this.reconnectTimer);
    const retry = setTimeout(() => {
      if (this.reconnectTimer !== retry || !this.isCurrent(generation, session)) return;
      this.reconnectTimer = null;
      this.connect(generation);
    }, 3000);
    this.reconnectTimer = retry;
    this.reconnectTimer.unref?.();
    this.emitStatus();
  }
}
module.exports = { SyncEngine };
