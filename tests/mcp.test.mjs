import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { createMcp } = createRequire(import.meta.url)('../desktop/mcp.cjs');
test('MCP transport rejects unauthenticated and browser requests, initializes and exposes tools', async t => {
  const mcp = createMcp({ getSession: () => null, emit() {} }); await mcp.start(); t.after(() => mcp.stop());
  const config = mcp.config().mcpServers.jianjian;
  const request = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
  assert.equal((await fetch(config.url, { method: 'POST', body: JSON.stringify(request) })).status, 403);
  assert.equal((await fetch(config.url, { method: 'POST', headers: { ...config.headers, Origin: 'https://example.com' }, body: JSON.stringify(request) })).status, 403);
  const result = await (await fetch(config.url, { method: 'POST', headers: config.headers, body: JSON.stringify(request) })).json();
  assert.equal(result.result.serverInfo.name, 'jianjian');
  assert.equal((await mcp.dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.length, 4);
  assert.equal((await mcp.dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'send_message', arguments: { text: 'hello' } } })).result.isError, true);
});
test('MCP streams file bytes and sends text with the active account, rejects late results', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'jianjian-mcp-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'image.png'); await writeFile(path, 'test-bytes');
  let session = { server: 'https://test.invalid', token: 'secret' }, switchAccount = false;
  const events = [], calls = [];
  const mcp = createMcp({ getSession: () => session, emit: e => events.push(e), fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/files')) { const chunks = []; for await (const chunk of options.body) chunks.push(chunk); assert.equal(Buffer.concat(chunks).toString(), 'test-bytes'); }
    return { ok: true, json: async () => { if (switchAccount) session = {}; return { id: 'message' }; } };
  } });
  await mcp.call('upload_file', { path }); assert.equal(calls[0].options.headers.Authorization, 'Bearer secret');
  await mcp.call('send_message', { text: 'hello' }); assert.equal(events.length, 2);
  await assert.rejects(mcp.call('upload_file', { path: 'relative.txt' }), /绝对/);
  switchAccount = true; await assert.rejects(mcp.call('send_message', { text: 'old' }), /账号/); assert.equal(events.length, 2);
});
