import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const { createDownloads } = createRequire(import.meta.url)('../desktop/downloads.cjs');
async function fixture(t, fetchImpl) {
  const dir = await mkdtemp(join(tmpdir(), 'jianjian-download-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const events = [], manager = createDownloads({ emit: event => events.push(event.data), fetchImpl });
  t.after(() => manager.clear());
  const start = () => manager.start({ session: { server: 'https://test.invalid', token: 'test' }, fileId: 'file-id', filename: 'large.bin', target: join(dir, 'large.bin'), active: () => true });
  return { dir, events, manager, start };
}
test('desktop download reports connecting, progress, saving and completion with bytes on disk', async t => {
  const f = await fixture(t, async () => new Response(new Uint8Array(2 * 1024 * 1024), { headers: { 'Content-Length': String(2 * 1024 * 1024) } }));
  const task = f.start(); assert.equal(f.events[0].status, 'starting'); await task.done;
  assert.equal(f.events.at(-1).status, 'completed'); assert.equal(f.events.at(-1).loaded, 2 * 1024 * 1024);
  assert.equal((await readFile(join(f.dir, 'large.bin'))).length, 2 * 1024 * 1024);
  assert.ok(f.events.some(e => e.status === 'downloading')); assert.ok(f.events.some(e => e.status === 'saving'));
  assert.equal(f.manager.list()[0].session, undefined); assert.equal(f.manager.list()[0].controller, undefined);
});
test('desktop cancellation removes partial data and preserves an existing destination', async t => {
  const f = await fixture(t, async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024)); } })));
  await writeFile(join(f.dir, 'large.bin'), 'existing'); const task = f.start();
  await new Promise(r => setTimeout(r, 40)); f.manager.cancel(task.id); await task.done;
  assert.equal(f.events.at(-1).status, 'canceled'); assert.equal(await readFile(join(f.dir, 'large.bin'), 'utf8'), 'existing');
  assert.deepEqual(await readdir(f.dir), ['large.bin']);
});
test('desktop network failures and truncated files report failure without publishing completion', async t => {
  const f = await fixture(t, async () => new Response('short', { headers: { 'Content-Length': '999' } }));
  await f.start().done; assert.equal(f.events.at(-1).status, 'failed'); assert.match(f.events.at(-1).error, /不完整/); assert.deepEqual(await readdir(f.dir), []);
});
test('clearing account cancels a download and suppresses late progress from the former account', async t => {
  const f = await fixture(t, async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024)); } })));
  const task = f.start(); await new Promise(r => setTimeout(r, 40)); f.manager.clear(); const count = f.events.length; await task.done;
  assert.equal(f.events.length, count); assert.equal(f.manager.list().length, 0); assert.deepEqual(await readdir(f.dir), []);
});
test('desktop emits intermediate byte counts and speed before a slow download completes', async t => {
  const f = await fixture(t, async () => new Response(new ReadableStream({ start(controller) {
    let count = 0; const timer = setInterval(() => { controller.enqueue(new Uint8Array(65536)); if (++count === 4) { clearInterval(timer); controller.close(); } }, 150);
  } }), { headers: { 'Content-Length': String(4 * 65536) } }));
  await f.start().done;
  assert.ok(f.events.some(e => e.status === 'downloading' && e.loaded > 0 && e.loaded < 4 * 65536 && e.speed > 0));
  assert.equal(f.events.at(-1).status, 'completed');
});
