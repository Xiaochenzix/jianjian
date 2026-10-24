import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { unlink, rename, statfs, readdir, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { resolve, join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, config, createUser, verifyPassword, digest, hashPassword } from './store.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86400000;
const publicMessage = row => row && ({ ...row, user_id: undefined, client_id: undefined });
class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new ApiError(status, message); };

export function createApp({ dataDir = resolve(process.env.DATA_DIR || join(root, 'data')), now = () => Date.now(), uploadLimitBytes } = {}) {
  const db = openStore(dataDir);
  const subscribers = new Map();
  const attempts = new Map();
  const uploads = new Map();
  let shuttingDown = false;
  const messageSelect = 'SELECT m.*, d.name AS device_name, d.platform FROM messages m JOIN devices d ON d.id=m.device_id';
  function emit(userId, event, payload) {
    for (const stream of subscribers.get(userId) || []) {
      if (!stream.res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)) stream.res.destroy();
    }
  }
  function disconnect(userId, deviceId) {
    for (const stream of subscribers.get(userId) || []) if (!deviceId || stream.deviceId === deviceId) stream.res.end();
  }
  function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }
  async function body(req) {
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 131072) fail(413, '请求内容过长');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
    catch { fail(400, 'JSON 格式错误'); }
  }
  function auth(req) {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
    if (!token) fail(401, '请先登录');
    const row = db.prepare(`SELECT s.*, u.username, u.role FROM sessions s JOIN users u ON s.user_id=u.id
      WHERE token_hash=? AND expires_at>? AND u.enabled=1`).get(digest(token), now());
    if (!row) fail(401, '登录已失效，请重新登录');
    db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(now(), row.device_id);
    return row;
  }
  function admin(session) { if (session.role !== 'admin') fail(403, '需要管理员权限'); }
  function getMessage(id, userId) { return db.prepare(`${messageSelect} WHERE m.id=? AND m.user_id=?`).get(id, userId); }
  function takeRate(key, max, period) {
    const current = attempts.get(key);
    const item = current && current.until > now() ? current : { count: 0, until: now() + period };
    item.count++; attempts.set(key, item);
    if (item.count > max) fail(429, '操作过于频繁，请稍后重试');
  }
  async function cleanup() {
    const expired = db.prepare("SELECT id,user_id FROM messages WHERE kind='file' AND expired=0 AND expires_at<=?").all(now());
    for (const row of expired) {
      try {
        await unlink(join(dataDir, 'files', row.id)).catch(e => { if (e.code !== 'ENOENT') throw e; });
        db.prepare('UPDATE messages SET expired=1 WHERE id=?').run(row.id);
        emit(row.user_id, 'changed', { id: row.id });
      } catch (e) { console.error('File cleanup failed:', e.code || e.message); }
    }
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now());
    for (const [key, value] of attempts) if (value.until < now()) attempts.delete(key);
    // Remove files orphaned by an interrupted upload or a process crash.
    for (const name of await readdir(join(dataDir, 'files'))) {
      const path = join(dataDir, 'files', name);
      if (name.endsWith('.part') && (await stat(path).catch(() => null))?.mtimeMs < now() - DAY) await unlink(path).catch(() => {});
      if (/^[0-9a-f-]{36}$/.test(name) && !db.prepare('SELECT 1 FROM messages WHERE id=?').get(name) && (await stat(path).catch(() => null))?.mtimeMs < now() - DAY) await unlink(path).catch(() => {});
    }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // No cookies: every private API request requires an explicit bearer token.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Filename, X-Client-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (path === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, name: '剪剪', version: '0.2.0' });
      if (path === '/api/login' && req.method === 'POST') {
        takeRate(`login:${req.socket.remoteAddress}`, 20, 60000);
        const b = await body(req);
        if (typeof b.username !== 'string' || typeof b.password !== 'string' || b.password.length > 256) fail(400, '请输入账号和密码');
        takeRate(`account:${b.username.toLowerCase()}`, 10, 60000);
        const user = db.prepare('SELECT * FROM users WHERE username=?').get(b.username);
        // A fixed dummy hash avoids a fast path for nonexistent accounts.
        const valid = await verifyPassword(b.password, user?.password_hash || `00000000000000000000000000000000:${'00'.repeat(64)}`);
        if (!valid || !user?.enabled) fail(401, '账号或密码错误');
        if (!/^[a-zA-Z0-9-]{16,80}$/.test(b.deviceKey || '')) fail(400, '设备标识无效');
        const name = String(b.deviceName || '未命名设备').trim().slice(0, 64) || '未命名设备';
        const platform = ['Windows', 'macOS', 'Linux', 'Android', 'Web'].includes(b.platform) ? b.platform : 'Web';
        const device = db.prepare('SELECT id FROM devices WHERE user_id=? AND client_key=?').get(user.id, b.deviceKey);
        const deviceId = device?.id || randomUUID();
        db.prepare(`INSERT INTO devices VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,client_key)
          DO UPDATE SET name=excluded.name, platform=excluded.platform,last_seen=excluded.last_seen`)
          .run(deviceId, user.id, b.deviceKey, name, platform, now());
        db.prepare('DELETE FROM sessions WHERE device_id=?').run(deviceId);
        disconnect(user.id, deviceId);
        const token = randomBytes(32).toString('base64url');
        db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(digest(token), user.id, deviceId, now() + 30 * DAY);
        return json(res, 200, { token, deviceId, username: user.username, role: user.role, config: config(db) });
      }
      if (!path.startsWith('/api/')) {
        const allowed = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css', '/icon.svg': 'icon.svg' };
        const file = allowed[path];
        if (!file || req.method !== 'GET') fail(404, '页面不存在');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
        res.setHeader('Content-Type', { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }[extname(file)]);
        res.end(readFileSync(join(root, 'web', file))); return;
      }
      const s = auth(req);
      if (path === '/api/me' && req.method === 'GET') return json(res, 200, { username: s.username, role: s.role, deviceId: s.device_id, config: config(db) });
      if (path === '/api/logout' && req.method === 'POST') {
        db.prepare('DELETE FROM sessions WHERE token_hash=?').run(s.token_hash); disconnect(s.user_id, s.device_id);
        return json(res, 200, { ok: true });
      }
      if (path === '/api/events' && req.method === 'GET') {
        const set = subscribers.get(s.user_id) || new Set();
        if (set.size >= 64) fail(429, '连接过多');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('event: ready\ndata: {}\n\n');
        const stream = { res, deviceId: s.device_id };
        set.add(stream); subscribers.set(s.user_id, set);
        const heartbeat = setInterval(() => {
          if (!db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?').get(s.token_hash, now())) { res.end(); return; }
          db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(now(), s.device_id);
          if (!res.write(': heartbeat\n\n')) res.destroy();
        }, 20000);
        res.on('close', () => { clearInterval(heartbeat); set.delete(stream); if (!set.size) subscribers.delete(s.user_id); });
        return;
      }
      if (path === '/api/devices' && req.method === 'GET') {
        return json(res, 200, db.prepare('SELECT id,name,platform,last_seen FROM devices WHERE user_id=? ORDER BY last_seen DESC').all(s.user_id));
      }
      if (path.startsWith('/api/devices/') && req.method === 'PATCH') {
        const name = String((await body(req)).name || '').trim().slice(0, 64);
        if (!name) fail(400, '请输入设备名称');
        if (!db.prepare('UPDATE devices SET name=? WHERE id=? AND user_id=?').run(name, path.split('/').at(-1), s.user_id).changes) fail(404, '设备不存在');
        emit(s.user_id, 'changed', {}); return json(res, 200, { ok: true });
      }
      if (path === '/api/messages' && req.method === 'GET') {
        const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 100);
        const kind = ['text', 'clipboard', 'file'].includes(url.searchParams.get('kind')) ? url.searchParams.get('kind') : '';
        const q = String(url.searchParams.get('q') || '').slice(0, 200).replace(/[\\%_]/g, c => `\\${c}`);
        const rows = db.prepare(`${messageSelect} WHERE m.user_id=? AND m.seq<? AND (?='' OR m.kind=?)
          AND (?='' OR COALESCE(m.text,m.filename) LIKE ? ESCAPE '\\') ORDER BY m.seq DESC LIMIT ?`)
          .all(s.user_id, before, kind, kind, q, `%${q}%`, limit);
        return json(res, 200, { items: rows.map(publicMessage), nextBefore: rows.length === limit ? rows.at(-1).seq : null });
      }
      if (path === '/api/messages' && req.method === 'POST') {
        takeRate(`send:${s.user_id}`, 120, 60000);
        const b = await body(req);
        if (!['text', 'clipboard'].includes(b.kind) || typeof b.text !== 'string' || !b.text.trim() || b.text.length > 32768) fail(400, '文字需为 1–32768 字符');
        if (!/^[a-zA-Z0-9-]{16,80}$/.test(b.clientId || '')) fail(400, '消息标识无效');
        const previous = db.prepare('SELECT id FROM messages WHERE user_id=? AND device_id=? AND client_id=?').get(s.user_id, s.device_id, b.clientId);
        if (previous) return json(res, 200, publicMessage(getMessage(previous.id, s.user_id)));
        const id = randomUUID();
        db.prepare('INSERT INTO messages (id,user_id,device_id,kind,text,created_at,client_id) VALUES (?,?,?,?,?,?,?)')
          .run(id, s.user_id, s.device_id, b.kind, b.text, now(), b.clientId);
        const item = publicMessage(getMessage(id, s.user_id));
        emit(s.user_id, 'message', item); return json(res, 201, item);
      }
      if (path === '/api/files' && req.method === 'POST') {
        const c = config(db); const maxBytes = uploadLimitBytes ?? c.maxFileMB * 1024 * 1024;
        if ((uploads.get(s.user_id) || 0) >= 2) fail(429, '请等待当前文件上传完成');
        const space = await statfs(dataDir);
        // Recheck after the asynchronous filesystem query so concurrent uploads reserve quota atomically.
        if ((uploads.get(s.user_id) || 0) >= 2) fail(429, '请等待当前文件上传完成');
        const used = db.prepare("SELECT COALESCE(SUM(size),0) AS size FROM messages WHERE user_id=? AND kind='file' AND expired=0").get(s.user_id).size;
        const remaining = c.userQuotaMB * 1024 * 1024 - used;
        const reserve = uploads.get(`${s.user_id}:bytes`) || 0;
        const globalReserve = uploads.get('global:bytes') || 0;
        const allowance = Math.min(maxBytes, remaining - reserve, space.bavail * space.bsize - globalReserve - 256 * 1024 * 1024);
        if (allowance <= 0) fail(507, '存储空间不足，请清理文件');
        if (Number(req.headers['content-length']) > allowance) fail(413, '文件超过大小或存储额度限制');
        let name;
        try { name = decodeURIComponent(req.headers['x-filename'] || ''); } catch { fail(400, '文件名无效'); }
        name = name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 200);
        if (!name) fail(400, '缺少文件名');
        const clientId = req.headers['x-client-id'];
        if (!/^[a-zA-Z0-9-]{16,80}$/.test(clientId || '')) fail(400, '文件标识无效');
        const previous = db.prepare('SELECT id FROM messages WHERE user_id=? AND device_id=? AND client_id=?').get(s.user_id, s.device_id, clientId);
        if (previous) { req.resume(); return json(res, 200, publicMessage(getMessage(previous.id, s.user_id))); }
        const id = randomUUID(); const temp = join(dataDir, 'files', `${id}.part`); const target = join(dataDir, 'files', id);
        uploads.set(s.user_id, (uploads.get(s.user_id) || 0) + 1);
        uploads.set(`${s.user_id}:bytes`, reserve + allowance);
        uploads.set('global:bytes', globalReserve + allowance);
        let size = 0;
        try {
          const counter = new Transform({ transform(chunk, enc, cb) {
            size += chunk.length; cb(size > allowance ? new ApiError(413, '文件超过大小限制') : null, chunk);
          } });
          await pipeline(req, counter, createWriteStream(temp, { flags: 'wx' }));
          if (!db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?').get(s.token_hash, now())) fail(401, '登录已失效');
          await rename(temp, target);
          db.prepare('INSERT INTO messages (id,user_id,device_id,kind,filename,size,created_at,expires_at,client_id) VALUES (?,?,?,?,?,?,?,?,?)')
            .run(id, s.user_id, s.device_id, 'file', name, size, now(), now() + c.retentionDays * DAY, clientId);
          const item = publicMessage(getMessage(id, s.user_id));
          emit(s.user_id, 'message', item); return json(res, 201, item);
        } catch (e) {
          await unlink(temp).catch(() => {}); await unlink(target).catch(() => {});
          if (e.code === 'ERR_SQLITE_ERROR' || e.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE') {
            const dup = db.prepare('SELECT id FROM messages WHERE user_id=? AND device_id=? AND client_id=?').get(s.user_id, s.device_id, clientId);
            if (dup) return json(res, 200, publicMessage(getMessage(dup.id, s.user_id)));
          }
          throw e;
        } finally {
          uploads.set(s.user_id, uploads.get(s.user_id) - 1);
          uploads.set(`${s.user_id}:bytes`, uploads.get(`${s.user_id}:bytes`) - allowance);
          uploads.set('global:bytes', uploads.get('global:bytes') - allowance);
        }
      }
      if (path.startsWith('/api/files/') && req.method === 'GET') {
        const item = getMessage(path.split('/').at(-1), s.user_id);
        if (!item || item.kind !== 'file') fail(404, '文件不存在');
        if (item.expired || item.expires_at <= now()) fail(410, '文件已过期');
        const file = join(dataDir, 'files', item.id);
        if (!existsSync(file)) fail(410, '文件已清理');
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': item.size,
          'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(item.filename).replace(/'/g, '%27')}` });
        await pipeline(createReadStream(file), res); return;
      }
      if (path.startsWith('/api/messages/') && req.method === 'DELETE') {
        const item = getMessage(path.split('/').at(-1), s.user_id);
        if (!item) fail(404, '消息不存在');
        if (item.kind === 'file') await unlink(join(dataDir, 'files', item.id)).catch(e => { if (e.code !== 'ENOENT') throw e; });
        db.prepare('DELETE FROM messages WHERE id=? AND user_id=?').run(item.id, s.user_id);
        emit(s.user_id, 'deleted', { id: item.id }); return json(res, 200, { ok: true });
      }
      if (path.startsWith('/api/admin/')) {
        admin(s);
        if (path === '/api/admin/users' && req.method === 'GET') return json(res, 200, db.prepare(`SELECT u.id,u.username,u.role,u.enabled,u.created_at,
          (SELECT COUNT(*) FROM devices WHERE user_id=u.id) AS devices FROM users u ORDER BY created_at`).all());
        if (path === '/api/admin/users' && req.method === 'POST') {
          const b = await body(req);
          try { return json(res, 201, await createUser(db, b.username, b.password)); }
          catch (e) { fail(400, e.message.includes('UNIQUE') ? '账号已存在' : e.message); }
        }
        if (path.startsWith('/api/admin/users/') && req.method === 'PATCH') {
          const id = path.split('/').at(-1); const b = await body(req);
          if (id === s.user_id) fail(400, '不能在这里停用或重置当前管理员');
          if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(id)) fail(404, '账号不存在');
          if (b.password !== undefined) {
            if (typeof b.password !== 'string' || b.password.length < 12 || b.password.length > 256) fail(400, '密码需为 12–256 位');
            db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await hashPassword(b.password), id);
          }
          if (typeof b.enabled === 'boolean') db.prepare('UPDATE users SET enabled=? WHERE id=?').run(Number(b.enabled), id);
          db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); disconnect(id);
          return json(res, 200, { ok: true });
        }
        if (path === '/api/admin/config' && req.method === 'PATCH') {
          const b = await body(req);
          for (const [key, max] of [['maxFileMB', 10240], ['retentionDays', 365], ['userQuotaMB', 1048576]]) {
            if (b[key] !== undefined && (!Number.isInteger(b[key]) || b[key] < 1 || b[key] > max)) fail(400, `${key} 超出允许范围`);
          }
          for (const key of ['maxFileMB', 'retentionDays', 'userQuotaMB']) if (b[key] !== undefined) db.prepare('UPDATE settings SET value=? WHERE key=?').run(String(b[key]), key);
          return json(res, 200, config(db));
        }
      }
      fail(404, '接口不存在');
    } catch (e) {
      if (!e.status) console.error('Request failed:', e.code || e.message);
      if (!res.headersSent && !res.destroyed) json(res, e.status || 500, { error: e.status ? e.message : '服务器暂时无法处理请求' });
      else if (!res.destroyed) res.end();
    }
  });
  server.requestTimeout = 30 * 60 * 1000;
  server.headersTimeout = 30000;
  const timer = setInterval(() => cleanup().catch(e => console.error('Cleanup:', e.message)), 60000); timer.unref();
  async function close() {
    if (shuttingDown) return; shuttingDown = true; clearInterval(timer);
    for (const streams of subscribers.values()) for (const stream of streams) stream.res.end();
    await new Promise(resolveClose => server.close(resolveClose)); db.close();
  }
  return { server, db, cleanup, close };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  await app.cleanup();
  const host = process.env.HOST || '127.0.0.1'; const port = Number(process.env.PORT || 8787);
  app.server.listen(port, host, () => console.log(`剪剪 listening on http://${host}:${port}`));
  process.on('SIGTERM', () => app.close().then(() => process.exit(0)));
  process.on('SIGINT', () => app.close().then(() => process.exit(0)));
}
