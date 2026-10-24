import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { SyncEngine } = createRequire(import.meta.url)('../desktop/sync-engine.cjs');
function fixture() {
  let text = ''; let prefs = { autoSend: false, autoWrite: false }; const sent = []; const events = [];
  const engine = new SyncEngine({ clipboard: { readText: () => text, writeText: value => { text = value; } }, emit: e => events.push(e), getPrefs: () => prefs,
    fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true }; } });
  engine.session = { server: 'http://localhost', token: 'test', deviceId: 'local' };
  return { engine, sent, events, getText: () => text, copy: value => { text = value; }, prefs };
}
test('disabled auto-send never sends, enabled sends changed text once', async () => {
  const f = fixture(); f.copy('private'); await f.engine.poll(); assert.equal(f.sent.length, 0);
  f.prefs.autoSend = true; await f.engine.poll(); assert.equal(f.sent.length, 0);
  f.copy('share this'); await f.engine.poll(); await f.engine.poll(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].text, 'share this');
});
test('auto-write is independent and received clipboard does not echo back', async () => {
  const f = fixture(); f.prefs.autoSend = true;
  f.engine.receive('message', { kind: 'clipboard', text: 'remote', device_id: 'other' }); assert.equal(f.getText(), '');
  f.prefs.autoWrite = true;
  f.engine.receive('message', { kind: 'clipboard', text: 'remote', device_id: 'other' }); assert.equal(f.getText(), 'remote');
  await f.engine.poll(); assert.equal(f.sent.length, 0);
  f.engine.receive('message', { kind: 'text', text: 'own message', device_id: 'local' }); assert.equal(f.getText(), 'remote');
});
test('manual copy and historical catch-up do not cause clipboard loops or overwrite', async () => {
  const f = fixture(); f.prefs.autoSend = true; f.prefs.autoWrite = true;
  f.engine.copy('manual'); await f.engine.poll(); assert.equal(f.sent.length, 0);
  f.engine.receive('ready', { text: 'historical' }); assert.equal(f.getText(), 'manual');
});
test('offline retry uses the same message identifier and disabling drops pending clipboard', async () => {
  const f = fixture(); f.prefs.autoSend = true; f.copy('offline'); let attempt = 0; const ids = [];
  f.engine.fetch = async (_url, options) => { ids.push(JSON.parse(options.body).clientId); if (!attempt++) throw new Error('offline'); return { ok: true }; };
  await f.engine.poll(); await f.engine.poll(); assert.equal(ids[0], ids[1]); assert.equal(f.engine.pending, null);
  f.engine.fetch = async () => { throw new Error('offline'); }; f.copy('private'); await f.engine.poll(); assert.ok(f.engine.pending);
  f.prefs.autoSend = false; await f.engine.poll(); assert.equal(f.engine.pending, null);
});
test('a newer received clipboard discards an older unsent clipboard', async () => {
  const f = fixture(); f.prefs.autoSend = true; f.prefs.autoWrite = true;
  f.engine.fetch = async () => { throw new Error('offline'); };
  f.copy('old offline content'); await f.engine.poll(); assert.ok(f.engine.pending);
  f.engine.receive('message', { kind: 'clipboard', text: 'new remote content', device_id: 'other' });
  assert.equal(f.engine.pending, null); assert.equal(f.getText(), 'new remote content');
});
