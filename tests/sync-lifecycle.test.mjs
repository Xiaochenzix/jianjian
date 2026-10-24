import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as turn } from 'node:timers/promises';
import { createRequire } from 'node:module';
const { SyncEngine } = createRequire(import.meta.url)('../desktop/sync-engine.cjs');

const session = name => ({ server: 'https://sync.test', token: `token-${name}`, deviceId: `device-${name}`, username: name });
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function stream() {
  const reads = [], queued = [];
  let cancelled = 0, responseCancelled = 0, released = 0;
  const reader = {
    read() {
      if (queued.length) return Promise.resolve(queued.shift());
      const waiting = deferred(); reads.push(waiting); return waiting.promise;
    },
    // Deliberately let an already-pending read arrive after cancellation. An engine
    // must reject stale results even when a transport ignores its AbortSignal.
    cancel() { cancelled++; return Promise.resolve(); },
    releaseLock() { released++; }
  };
  const push = result => reads.length ? reads.shift().resolve(result) : queued.push(result);
  return {
    response: { ok: true, status: 200, body: { getReader: () => reader, cancel() { responseCancelled++; return Promise.resolve(); } } },
    event(type, data) { push({ done: false, value: new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`) }); },
    raw(text) { push({ done: false, value: new TextEncoder().encode(text) }); },
    end() { push({ done: true }); },
    get pendingReads() { return reads.length; },
    get cancelled() { return cancelled; },
    get responseCancelled() { return responseCancelled; },
    get released() { return released; }
  };
}
function fixture(t, onEvent = () => {}) {
  let text = '';
  const events = [], requests = [], prefs = { autoSend: false, autoWrite: true };
  const engine = new SyncEngine({
    clipboard: { readText: () => text, writeText: value => { text = value; } },
    getPrefs: () => prefs,
    emit(event) { events.push(event); onEvent(event, engine); },
    fetchImpl(url, options) {
      const waiting = deferred(); requests.push({ url, options, ...waiting }); return waiting.promise;
    }
  });
  t.after(() => engine.stop());
  return { engine, events, requests, prefs, get text() { return text; }, copy(value) { text = value; } };
}

test('starting an identical session reuses its stream, polling and pending clipboard', async t => {
  const f = fixture(t), current = session('one'), live = stream();
  assert.equal(f.engine.start(current), true);
  f.requests[0].resolve(live.response); await turn();
  const generation = f.engine.generation, timer = f.engine.pollTimer;
  const pending = { text: 'offline content', clientId: 'unchanged' }; f.engine.pending = pending;
  current.token = 'caller-mutated-token';
  assert.equal(f.engine.session.token, 'token-one');
  assert.equal(f.engine.start(session('one')), false);
  assert.equal(f.requests.length, 1);
  assert.equal(f.engine.generation, generation);
  assert.equal(f.engine.pollTimer, timer);
  assert.equal(f.engine.pending, pending);
  assert.equal(live.cancelled, 0);
  assert.equal(f.events.at(-1).type, 'status');
  assert.equal(f.events.at(-1).connected, true);
});

test('late unauthorized SSE response cannot log out the replacement account', async t => {
  const f = fixture(t), live = stream();
  f.engine.start(session('old')); const old = f.requests[0];
  f.engine.start(session('new')); f.requests[1].resolve(live.response); await turn();
  const eventCount = f.events.length;
  old.resolve({ ok: false, status: 401 }); await turn();
  assert.equal(old.options.signal.aborted, true);
  assert.equal(f.engine.session.username, 'new');
  assert.equal(f.engine.connected, true);
  assert.equal(f.events.length, eventCount);
  assert(!f.events.some(event => event.type === 'auth'));
  assert.equal(f.engine.reconnectTimer, null);
});

test('late successful SSE response is cancelled without emitting status or messages', async t => {
  const f = fixture(t), stale = stream();
  f.engine.start(session('old')); const old = f.requests[0];
  f.engine.start(session('new')); const eventCount = f.events.length;
  stale.event('message', { kind: 'text', text: 'old private message', device_id: 'remote' });
  old.resolve(stale.response); await turn();
  assert.equal(stale.responseCancelled, 1);
  assert.equal(stale.pendingReads, 0);
  assert.equal(f.events.length, eventCount);
  assert.equal(f.text, '');
  assert.equal(f.engine.session.username, 'new');
});

test('a pending stream read arriving after account switch cannot write the clipboard', async t => {
  const f = fixture(t), oldStream = stream(), newStream = stream();
  f.engine.start(session('old')); f.requests[0].resolve(oldStream.response); await turn();
  assert.equal(oldStream.pendingReads, 1);
  f.engine.start(session('new')); f.requests[1].resolve(newStream.response); await turn();
  const eventCount = f.events.length;
  oldStream.event('message', { kind: 'clipboard', text: 'stale account text', device_id: 'remote' });
  await turn();
  assert.equal(f.events.length, eventCount);
  assert.equal(f.text, '');
  assert(oldStream.cancelled >= 1);
  assert.equal(oldStream.released, 1);
  newStream.event('message', { kind: 'clipboard', text: 'new account text', device_id: 'remote' });
  await turn();
  assert.equal(f.text, 'new account text');
  assert.equal(f.events.at(-1).data.text, 'new account text');
});

test('an old clipboard POST cannot clear the new send lock or revoke the new session', async t => {
  const f = fixture(t); f.prefs.autoSend = true;
  f.engine.start(session('old')); f.copy('old clipboard');
  const oldPoll = f.engine.poll(), oldPost = f.requests.at(-1);
  assert(oldPost.url.endsWith('/api/messages'));
  f.engine.start(session('new')); f.copy('new clipboard');
  const newPoll = f.engine.poll(), newPost = f.requests.at(-1);
  assert.equal(oldPost.options.signal.aborted, true);
  assert.equal(newPost.options.headers.Authorization, 'Bearer token-new');
  assert.equal(JSON.parse(newPost.options.body).text, 'new clipboard');
  oldPost.resolve({ ok: false, status: 401 }); await oldPoll;
  assert.equal(f.engine.session.username, 'new');
  assert.equal(f.engine.sending, true);
  assert.equal(f.engine.pending.text, 'new clipboard');
  assert(!f.events.some(event => event.type === 'auth'));
  const count = f.requests.length; await f.engine.poll();
  assert.equal(f.requests.length, count, 'new request must keep its own send lock');
  newPost.resolve({ ok: true, status: 200 }); await newPoll;
  assert.equal(f.engine.sending, false);
  assert.equal(f.engine.pending, null);
});

test('stop ignores late failures and leaves no reconnect or polling timer', async t => {
  const f = fixture(t);
  f.engine.start(session('one')); const pending = f.requests[0];
  f.engine.stop(); const eventCount = f.events.length;
  pending.resolve({ ok: false, status: 401 }); await turn();
  assert.equal(f.events.length, eventCount);
  assert.equal(f.engine.session, null);
  assert.equal(f.engine.controller, null);
  assert.equal(f.engine.pollTimer, null);
  assert.equal(f.engine.reconnectTimer, null);
});

test('unauthorized current connection emits one auth event and stops its timers', async t => {
  const f = fixture(t);
  f.engine.start(session('one')); f.requests[0].resolve({ ok: false, status: 401 }); await turn();
  assert.equal(f.events.filter(event => event.type === 'auth').length, 1);
  assert.equal(f.engine.session, null);
  assert.equal(f.engine.pollTimer, null);
  assert.equal(f.engine.reconnectTimer, null);
});

test('switching account during a batch stops dispatch of remaining old-account events', async t => {
  const f = fixture(t, (event, engine) => {
    if (event.type === 'message' && event.data.text === 'first') engine.start(session('new'));
  });
  const live = stream();
  f.engine.start(session('old')); f.requests[0].resolve(live.response); await turn();
  const block = text => `event: message\ndata: ${JSON.stringify({ kind: 'text', text, device_id: 'remote' })}\n\n`;
  live.raw(block('first') + block('must not enter new account')); await turn();
  assert.equal(f.engine.session.username, 'new');
  assert.equal(f.text, 'first');
  assert.deepEqual(f.events.filter(event => event.type === 'message').map(event => event.data.text), ['first']);
});

test('repeated start during reconnection preserves the scheduled retry', async t => {
  const f = fixture(t);
  f.engine.start(session('one')); f.requests[0].reject(new Error('offline')); await turn();
  const retry = f.engine.reconnectTimer;
  assert(retry);
  assert.equal(f.engine.start(session('one')), false);
  assert.equal(f.engine.reconnectTimer, retry);
  assert.equal(f.requests.length, 1);
  assert.equal(f.events.at(-1).connected, false);
});
