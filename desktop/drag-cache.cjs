const { createWriteStream, existsSync, mkdirSync, utimesSync } = require('node:fs');
const { rename, unlink, rm, readdir, stat } = require('node:fs/promises');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createHash } = require('node:crypto');
const { join, basename } = require('node:path');

const FILE_ID = /^[0-9a-f-]{36}$/;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;

// The dropped file keeps its original name, so strip anything Windows/a file manager rejects.
function safeName(value) {
  const name = basename(String(value || '文件').replaceAll('\\', '/'))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim().slice(0, 120);
  return name || '文件';
}

function createDragCache({ root, fetchImpl = fetch }) {
  const pending = new Map();
  const scope = session => createHash('sha256').update(String(session.server)).digest('hex').slice(0, 8);
  const dirFor = (session, fileId) => join(root, `${scope(session)}-${fileId}`);
  const pathFor = (session, fileId, filename) => join(dirFor(session, fileId), safeName(filename));

  // Synchronous lookup: startDrag has to happen while the user still holds the mouse button.
  function existing(session, fileId, filename) {
    if (!session || !FILE_ID.test(String(fileId))) return null;
    const file = pathFor(session, fileId, filename);
    if (!existsSync(file)) return null;
    // 拖过就算用上了，别在下次启动时被当成过期缓存清掉
    const now = new Date();
    try { utimesSync(file, now, now); } catch { /* 时间是尽力而为 */ }
    return file;
  }

  function prepare(session, fileId, filename) {
    if (!session || !FILE_ID.test(String(fileId))) return Promise.reject(new Error('文件标识无效'));
    const file = pathFor(session, fileId, filename);
    if (existsSync(file)) return Promise.resolve(file);
    if (pending.has(file)) return pending.get(file);
    const job = (async () => {
      mkdirSync(dirFor(session, fileId), { recursive: true });
      const temp = `${file}.${process.pid}.part`;
      const signal = AbortSignal.timeout(30 * 60 * 1000);
      try {
        const response = await fetchImpl(`${session.server}/api/files/${fileId}`, { headers: { Authorization: `Bearer ${session.token}` }, signal });
        if (!response.ok) throw new Error('文件下载失败，请重试');
        await pipeline(Readable.fromWeb(response.body), createWriteStream(temp, { flags: 'w' }), { signal });
        await rename(temp, file);
        return file;
      } catch (error) {
        await unlink(temp).catch(() => {});
        throw error.name === 'TimeoutError' ? new Error('文件准备超时，请重试') : error;
      }
    })().finally(() => pending.delete(file));
    pending.set(file, job);
    return job;
  }

  // Cached copies are a convenience only; drop anything the user has not dragged for a week.
  async function prune(maxAge = MAX_AGE) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
      const dir = join(root, entry.name);
      const names = await readdir(dir).catch(() => []);
      if (!names.length) { await rm(dir, { recursive: true, force: true }).catch(() => {}); return; }
      const times = await Promise.all(names.map(name => stat(join(dir, name)).then(info => info.mtimeMs).catch(() => 0)));
      if (Date.now() - Math.max(...times) > maxAge) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }));
  }

  return { existing, prepare, prune };
}

module.exports = { createDragCache, FILE_ID };
