import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/index.mjs';
import { createUser } from '../server/store.mjs';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'jianjian-test-'));
  let clock = Date.now(); const app = createApp({ dataDir: dir, now: () => clock, ...options });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  await createUser(app.db, 'owner', 'test-password-owner', 'admin');
  await createUser(app.db, 'other', 'test-password-other');
  async function req(path, { token, body, method = 'GET', headers, ...rest } = {}) {
    return fetch(`${origin}/api${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && typeof body !== 'string' && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body && typeof body !== 'string' && !(body instanceof Uint8Array) ? JSON.stringify(body) : body, ...rest });
  }
  async function login(name = 'owner', key = randomUUID()) {
    const r = await req('/login', { method: 'POST', body: { username: name, password: `test-password-${name}`, deviceKey: key, deviceName: name + ' laptop', platform: 'Windows' } });
    assert.equal(r.status, 200); return r.json();
  }
  const owner = await login(), other = await login('other');
  const send = (session, text = 'hello', extra = {}) => req('/messages', { method: 'POST', token: session.token, body: { text, kind: 'text', clientId: randomUUID(), ...extra } });
  const upload = (session, content = 'a file', name = '测试.txt') => req('/files', { method: 'POST', token: session.token, body: content, headers: { 'X-Filename': encodeURIComponent(name), 'X-Client-Id': randomUUID(), 'Content-Type': 'application/octet-stream' } });
  return { app, dir, req, login, owner, other, send, upload, advance: n => { clock += n; } };
}
test('authentication, private endpoints and closed registration', async t => {
  const f = await fixture(t);
  assert.equal((await f.req('/messages')).status, 401);
  assert.equal((await f.req('/register', { method: 'POST' })).status, 401);
  assert.equal((await f.req('/login', { method: 'POST', body: { username: 'owner', password: 'wrong', deviceKey: randomUUID() } })).status, 401);
  assert.equal((await f.req('/admin/users', { token: f.other.token })).status, 403);
  const hash = f.app.db.prepare('SELECT password_hash FROM users WHERE username=?').get('owner').password_hash;
  assert.ok(!hash.includes('test-password')); assert.equal(f.app.db.prepare('SELECT token_hash FROM sessions LIMIT 1').get().token_hash.length, 64);
});
test('different accounts cannot list, download, rename or delete each other’s resources', async t => {
  const f = await fixture(t); const item = await (await f.upload(f.owner)).json();
  assert.equal((await (await f.req('/messages', { token: f.other.token })).json()).items.length, 0);
  assert.equal((await f.req(`/files/${item.id}`, { token: f.other.token })).status, 404);
  assert.equal((await f.req(`/messages/${item.id}`, { token: f.other.token, method: 'DELETE' })).status, 404);
  assert.equal((await f.req(`/devices/${f.owner.deviceId}`, { token: f.other.token, method: 'PATCH', body: { name: 'hijack' } })).status, 404);
  const file = await f.req(`/files/${item.id}`, { token: f.owner.token }); assert.equal(await file.text(), 'a file');
});
test('messages are idempotent and keep trusted source-device attribution', async t => {
  const f = await fixture(t); const id = randomUUID();
  const a = await (await f.send(f.owner, 'hello', { clientId: id, device_id: f.other.deviceId })).json();
  const b = await (await f.send(f.owner, 'hello', { clientId: id })).json();
  assert.equal(a.id, b.id); assert.equal(a.device_id, f.owner.deviceId); assert.equal(a.device_name, 'owner laptop');
  assert.equal((await (await f.req('/messages', { token: f.owner.token })).json()).items.length, 1);
});
test('offline catch-up, pagination, type and literal-text search', async t => {
  const f = await fixture(t); await f.send(f.owner, '100% complete'); await f.send(f.owner, 'copied link', { kind: 'clipboard' }); await f.send(f.owner, 'latest');
  const secondDevice = await f.login();
  const first = await (await f.req('/messages?limit=2', { token: secondDevice.token })).json(); assert.equal(first.items.length, 2); assert.equal(first.items[0].text, 'latest');
  const next = await (await f.req(`/messages?before=${first.nextBefore}&limit=2`, { token: secondDevice.token })).json(); assert.equal(next.items[0].text, '100% complete');
  assert.equal((await (await f.req('/messages?kind=clipboard', { token: f.owner.token })).json()).items.length, 1);
  assert.equal((await (await f.req('/messages?q=%25', { token: f.owner.token })).json()).items.length, 1);
});
test('file size limit, unicode filename and expiry remove file bytes', async t => {
  const f = await fixture(t, { uploadLimitBytes: 12 });
  assert.equal((await f.upload(f.owner, 'x'.repeat(13))).status, 413);
  const item = await (await f.upload(f.owner)).json(); assert.equal(item.filename, '测试.txt');
  const download = await f.req(`/files/${item.id}`, { token: f.owner.token }); assert.match(download.headers.get('content-disposition'), /filename\*=UTF-8/); await download.arrayBuffer();
  f.advance(8 * 86400000); await f.app.cleanup();
  assert.equal((await f.req(`/files/${item.id}`, { token: f.owner.token })).status, 410);
  assert.equal((await readdir(join(f.dir, 'files'))).length, 0);
});
test('delete removes message and stored file', async t => {
  const f = await fixture(t); const item = await (await f.upload(f.owner)).json();
  assert.equal((await f.req(`/messages/${item.id}`, { token: f.owner.token, method: 'DELETE' })).status, 200);
  assert.equal((await readdir(join(f.dir, 'files'))).length, 0);
  assert.equal((await f.req(`/files/${item.id}`, { token: f.owner.token })).status, 404);
});
test('admin creates users, validates policy and revokes disabled user sessions', async t => {
  const f = await fixture(t);
  assert.equal((await f.req('/admin/users', { token: f.owner.token, method: 'POST', body: { username: 'third', password: 'long-test-password' } })).status, 201);
  assert.equal((await f.req('/admin/config', { token: f.owner.token, method: 'PATCH', body: { maxFileMB: -1 } })).status, 400);
  const cfg = await (await f.req('/admin/config', { token: f.owner.token, method: 'PATCH', body: { maxFileMB: 250, retentionDays: 3 } })).json(); assert.equal(cfg.maxFileMB, 250);
  const id = f.app.db.prepare('SELECT id FROM users WHERE username=?').get('other').id;
  assert.equal((await f.req(`/admin/users/${id}`, { token: f.owner.token, method: 'PATCH', body: { enabled: false } })).status, 200);
  assert.equal((await f.req('/me', { token: f.other.token })).status, 401);
});
test('SSE delivers same-account messages and deletion events', async t => {
  const f = await fixture(t); const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await f.req('/events', { token: f.owner.token, signal: controller.signal });
  const reader = response.body.getReader();
  const ready = new TextDecoder().decode((await reader.read()).value); assert.match(ready, /event: ready/);
  const message = await (await f.send(f.owner, 'live sync')).json();
  const event = new TextDecoder().decode((await reader.read()).value); assert.match(event, /live sync/);
  await f.req(`/messages/${message.id}`, { token: f.owner.token, method: 'DELETE' });
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: deleted/);
  controller.abort();
});
test('logout revokes token; logging in again on same device revokes previous token', async t => {
  const f = await fixture(t); const key = randomUUID(); const first = await f.login('owner', key); const second = await f.login('owner', key);
  assert.equal(first.deviceId, second.deviceId); assert.equal((await f.req('/me', { token: first.token })).status, 401);
  await f.req('/logout', { token: second.token, method: 'POST' }); assert.equal((await f.req('/me', { token: second.token })).status, 401);
});
