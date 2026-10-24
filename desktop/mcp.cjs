const http = require('node:http');
const { randomBytes, randomUUID } = require('node:crypto');
const { open } = require('node:fs/promises');
const { isAbsolute, basename } = require('node:path');
const tools = [
  { name: 'send_message', description: '向剪剪当前账号的所有设备发送文字', inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 32768 } }, required: ['text'], additionalProperties: false } },
  { name: 'upload_file', description: '上传本机绝对路径的文件到剪剪当前账号', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { name: 'list_messages', description: '读取当前账号最近的消息和文件记录', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false } },
  { name: 'list_devices', description: '查询当前账号设备', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
];
function createMcp({ getSession, emit, fetchImpl = fetch }) {
  let server, token, endpoint;
  const pending = new Set();
  async function call(name, args = {}) {
    const session = getSession();
    if (!session) throw new Error('请先在剪剪登录');
    const controller = new AbortController(); pending.add(controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30 * 60 * 1000)]);
    let file;
    try {
      let path, options = { headers: { Authorization: `Bearer ${session.token}` }, signal };
      if (name === 'send_message') {
        if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 32768) throw new Error('文字需为 1–32768 字符');
        path = '/messages'; options.method = 'POST'; options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify({ text: args.text, kind: 'text', clientId: randomUUID() });
      } else if (name === 'upload_file') {
        if (typeof args.path !== 'string' || !isAbsolute(args.path)) throw new Error('请提供文件绝对路径');
        file = await open(args.path, 'r'); const stat = await file.stat();
        if (!stat.isFile()) throw new Error('只能上传普通文件');
        if (stat.size > (session.config?.maxFileMB || 500) * 1048576) throw new Error('文件超过服务器大小限制');
        path = '/files'; options.method = 'POST'; options.duplex = 'half'; options.body = file.createReadStream({ autoClose: false });
        Object.assign(options.headers, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(stat.size), 'X-Filename': encodeURIComponent(basename(args.path)), 'X-Client-Id': randomUUID() });
      } else if (name === 'list_messages') {
        const limit = args.limit ?? 50; if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit 必须为 1–100');
        path = `/messages?limit=${limit}`;
      } else if (name === 'list_devices') path = '/devices';
      else throw new Error('未知工具');
      if (getSession() !== session || signal.aborted) throw new Error('账号已切换');
      const response = await fetchImpl(`${session.server}/api${path}`, options);
      const result = await response.json();
      if (getSession() !== session || signal.aborted) throw new Error('账号已切换');
      if (!response.ok) throw new Error(result.error || '请求失败');
      if (options.method === 'POST') emit({ type: 'message', data: result });
      return result;
    } finally { pending.delete(controller); if (file) await file.close(); }
  }
  async function dispatch(msg) {
    const base = { jsonrpc: '2.0', id: msg.id ?? null };
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return { ...base, error: { code: -32600, message: 'Invalid Request' } };
    if (msg.id === undefined) return null;
    if (msg.method === 'initialize') return { ...base, result: { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18'].includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'jianjian', version: '0.4.0' } } };
    if (msg.method === 'ping') return { ...base, result: {} };
    if (msg.method === 'tools/list') return { ...base, result: { tools } };
    if (msg.method === 'tools/call') {
      try { return { ...base, result: { content: [{ type: 'text', text: JSON.stringify(await call(msg.params?.name, msg.params?.arguments)) }] } }; }
      catch (error) { return { ...base, result: { isError: true, content: [{ type: 'text', text: error.message }] } }; }
    }
    return { ...base, error: { code: -32601, message: 'Method not found' } };
  }
  return {
    call, dispatch,
    cancel() { for (const controller of pending) controller.abort(); },
    async start() {
      if (server) return;
      token = randomBytes(32).toString('hex');
      server = http.createServer(async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.headers.origin || req.headers.host !== `127.0.0.1:${server.address().port}` || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
        if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
        if (req.method !== 'POST') { res.writeHead(405).end(); return; }
        try {
          let input = ''; for await (const chunk of req) { input += chunk; if (Buffer.byteLength(input) > 131072) { res.writeHead(413).end(); return; } }
          let msg; try { msg = JSON.parse(input); } catch { res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })); return; }
          const result = await dispatch(msg || {}); if (result === null) res.writeHead(202).end(); else res.end(JSON.stringify(result));
        } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
      });
      server.requestTimeout = 30000;
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      endpoint = `http://127.0.0.1:${server.address().port}/mcp`;
    },
    config() { return server ? { mcpServers: { jianjian: { url: endpoint, headers: { Authorization: `Bearer ${token}` } } } } : null; },
    stop() { this.cancel(); server?.closeAllConnections(); server?.close(); server = null; token = null; }
  };
}
module.exports = { createMcp };
