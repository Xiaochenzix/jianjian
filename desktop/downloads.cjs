const { createWriteStream } = require('node:fs');
const { unlink, rename } = require('node:fs/promises');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { randomUUID } = require('node:crypto');
function createDownloads({ emit, fetchImpl = fetch }) {
  const tasks = new Map();
  function update(task, status, extra = {}) {
    Object.assign(task, extra, { status });
    emit({ type: 'download', data: snapshot(task) });
  }
  function snapshot({ controller, session, ...data }) { return data; }
  return {
    list: () => [...tasks.values()].map(snapshot),
    cancel(id) { const task = tasks.get(id); if (task && ['starting', 'downloading', 'saving'].includes(task.status)) task.controller.abort(); },
    clear() { for (const task of tasks.values()) task.controller.abort(); tasks.clear(); },
    start({ session, fileId, filename, target, active }) {
      const id = randomUUID(), temp = `${target}.jianjian-${id}.part`;
      const task = { id, fileId, filename, loaded: 0, total: 0, speed: 0, status: 'starting', controller: new AbortController(), session };
      tasks.set(id, task); update(task, 'starting');
      const publish = (status, extra) => { if (active() && tasks.get(id) === task) update(task, status, extra); };
      const done = (async () => {
        let last = Date.now(), lastBytes = 0;
        try {
          const signal = AbortSignal.any([task.controller.signal, AbortSignal.timeout(30 * 60 * 1000)]);
          const response = await fetchImpl(`${session.server}/api/files/${fileId}`, { headers: { Authorization: `Bearer ${session.token}` }, signal });
          if (!response.ok) throw new Error((await response.json()).error || '下载失败');
          const declared = Number(response.headers.get('content-length')); task.total = Number.isFinite(declared) && declared > 0 ? declared : 0;
          publish('downloading');
          const meter = new Transform({ transform(chunk, encoding, callback) {
            task.loaded += chunk.length;
            const now = Date.now(); if (now - last >= 250) {
              task.speed = (task.loaded - lastBytes) * 1000 / Math.max(1, now - last); last = now; lastBytes = task.loaded; publish('downloading');
            }
            callback(null, chunk);
          } });
          await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temp, { flags: 'wx' }), { signal });
          if (signal.aborted || !active()) throw new Error('下载已取消');
          if (task.total && task.loaded !== task.total) throw new Error('文件传输不完整，请重试');
          publish('saving'); await rename(temp, target);
          publish('completed', { path: target, speed: 0 });
        } catch (error) {
          await unlink(temp).catch(() => {});
          publish(task.controller.signal.aborted || !active() ? 'canceled' : 'failed', { error: error.name === 'TimeoutError' ? '下载超时，请重试' : error.message, speed: 0 });
        }
      })();
      // Keep finished history bounded; active downloads are never removed.
      for (const [key, value] of tasks) if (tasks.size > 30 && ['completed', 'failed', 'canceled'].includes(value.status)) tasks.delete(key);
      return { started: true, id, done };
    }
  };
}
module.exports = { createDownloads };
