const { app, BrowserWindow } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, statSync } = require('node:fs');
const { join } = require('node:path');
const { once } = require('node:events');

let window;
let encoder;
let shuttingDown = false;
let rendererFailure;
let encoderFailure;
const encoderLog = [];
let encodedFrames = 0;
let encodedDuration = 0;
const config = JSON.parse(readFileSync(process.env.JIANJIAN_MV_CONFIG, 'utf8'));

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

function finish(code, error) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (error) console.error(error.stack || error.message || error);
  if (error && encoderLog.length) console.error(encoderLog.join('').trim());
  const exit = () => {
    if (window && !window.isDestroyed()) window.destroy();
    app.exit(code);
  };
  if (encoder && encoder.exitCode === null) {
    // Wait for file handles to close before the parent removes temporary files.
    const fallback = setTimeout(exit, 2000);
    encoder.once('close', () => { clearTimeout(fallback); exit(); });
    encoder.kill();
  } else exit();
}

process.on('uncaughtException', (error) => finish(1, error));
process.on('unhandledRejection', (error) => finish(1, error));
process.on('SIGINT', () => finish(130));
process.on('SIGTERM', () => finish(143));
app.on('window-all-closed', () => {});
app.on('before-quit', () => { if (encoder && encoder.exitCode === null) encoder.kill(); });
setInterval(() => {
  if (existsSync(config.cancelFile)) finish(130, new Error('Rendering cancelled.'));
}, 250).unref();

async function timed(promise, message, milliseconds = 30000) {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timeout); }
}

async function frameAt(time) {
  if (rendererFailure) throw rendererFailure;
  if (encoderFailure) throw encoderFailure;
  const data = await timed(window.webContents.executeJavaScript(`(() => {
    const canvas = document.getElementById('film');
    window.JianjianFilm.render(canvas, ${JSON.stringify(time)});
    return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
  })()`), `Rendering stalled at ${time.toFixed(3)} seconds.`);
  if (!data) throw new Error(`Empty canvas frame at ${time.toFixed(3)} seconds.`);
  return Buffer.from(data, 'base64');
}

function startEncoder() {
  const args = [
    '-hide_banner', '-loglevel', 'warning', '-nostdin', '-y',
    '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(config.fps), '-i', 'pipe:0',
    '-i', config.audio, '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-r', String(config.fps),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-t', String(config.duration), '-movflags', '+faststart', '-progress', 'pipe:1', config.temporaryOutput,
  ];
  encoder = spawn(config.ffmpeg, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let progressBuffer = '';
  encoder.stdout.on('data', (chunk) => {
    progressBuffer += chunk.toString();
    const lines = progressBuffer.split(/\r?\n/);
    progressBuffer = lines.pop();
    for (const line of lines) {
      const [key, value] = line.split('=');
      if (key === 'frame') encodedFrames = Number(value);
    }
  });
  const completion = new Promise((resolve, reject) => {
    encoder.once('error', (error) => { encoderFailure = error; reject(error); });
    encoder.once('close', (code, signal) => {
      if (code === 0) resolve();
      else {
        encoderFailure = new Error(`FFmpeg failed (${signal || code}).\n${encoderLog.join('')}`);
        reject(encoderFailure);
      }
    });
  });
  // Keep early encoder errors handled until the frame loop reaches the failure.
  completion.catch(() => {});
  encoder.stderr.on('data', (chunk) => {
    encoderLog.push(chunk.toString());
    if (encoderLog.length > 50) encoderLog.shift();
  });
  encoder.stdin.on('error', (error) => { encoderFailure = error; });
  return completion;
}

async function run() {
  await timed(app.whenReady(), 'Electron did not initialize.', 60000);
  window = new BrowserWindow({
    show: false, width: config.width, height: config.height,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    rendererFailure = new Error(`Canvas renderer exited: ${details.reason}.`);
    finish(1, rendererFailure);
  });
  await timed(window.loadFile(join(config.root, 'scripts', 'mv-render.html')), 'The MV page did not load.');
  const duration = await timed(window.webContents.executeJavaScript(`(async () => {
    await document.fonts.ready;
    if (!window.JianjianFilm || typeof window.JianjianFilm.render !== 'function') throw new Error('mv/film.js did not expose window.JianjianFilm.render.');
    const canvas = document.getElementById('film');
    canvas.width = ${config.width}; canvas.height = ${config.height};
    return window.JianjianFilm.duration;
  })()`), 'The MV fonts or renderer did not initialize.');
  if (duration !== config.duration) throw new Error(`Expected a ${config.duration}s film, received ${duration}s.`);
  if (config.frames) {
    mkdirSync(config.frameDirectory, { recursive: true });
    const frames = [];
    for (const time of config.frames) {
      const filename = `frame-${time.toFixed(3).padStart(7, '0').replace('.', '-')}.png`;
      const output = join(config.frameDirectory, filename);
      writeFileSync(output, await frameAt(time));
      frames.push({ time, filename });
      console.log(`Frame ${time.toFixed(3)}s: ${output}`);
    }
    writeFileSync(join(config.frameDirectory, 'frames.json'), JSON.stringify({ width: config.width, height: config.height, duration, frames }, null, 2));
    console.log(`Saved ${frames.length} PNG frames.`);
    return;
  }
  const completion = startEncoder();
  const totalFrames = config.duration * config.fps;
  for (let index = 0; index < totalFrames; index++) {
    const buffer = await frameAt(index / config.fps);
    if (encoderFailure || encoder.stdin.destroyed) throw encoderFailure || new Error('FFmpeg closed its input unexpectedly.');
    if (!encoder.stdin.write(buffer)) {
      await timed(Promise.race([
        once(encoder.stdin, 'drain'),
        completion.then(() => { throw new Error('FFmpeg stopped before all frames were written.'); }),
      ]), `FFmpeg stopped accepting frames at frame ${index + 1}.`, 60000);
    }
    if (index === 0 || (index + 1) % (config.fps * 4) === 0 || index + 1 === totalFrames) {
      console.log(`Rendered ${index + 1}/${totalFrames} frames (${Math.round((index + 1) / totalFrames * 100)}%).`);
    }
  }
  encoder.stdin.end();
  await timed(completion, 'FFmpeg did not finish the MP4 after the final frame.', 120000);
  if (encodedFrames !== totalFrames) throw new Error(`Expected ${totalFrames} encoded frames, received ${encodedFrames}.`);
  // Encoder progress reports the final packet timestamp, which can precede the
  // container duration with H.264 B-frames. Inspect the finished MP4 instead.
  const inspection = spawnSync(config.ffmpeg, ['-hide_banner', '-i', config.temporaryOutput], {
    windowsHide: true, encoding: 'utf8', timeout: 15000,
  });
  if (inspection.error) throw inspection.error;
  const durationMatch = inspection.stderr.match(/Duration:\s+(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!durationMatch) throw new Error(`Could not verify the finished MP4 duration.\n${inspection.stderr}`);
  encodedDuration = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
  if (!/Video: h264\b/.test(inspection.stderr) || !/Audio: aac\b/.test(inspection.stderr)) throw new Error(`Expected H.264 video and AAC audio.\n${inspection.stderr}`);
  if (Math.abs(encodedDuration - config.duration) > 1 / config.fps + 0.03) throw new Error(`Expected ${config.duration}s output, received ${encodedDuration.toFixed(3)}s.`);
  if (statSync(config.temporaryOutput).size < 1024) throw new Error('FFmpeg produced an unexpectedly small MP4.');
  renameSync(config.temporaryOutput, config.output);
  console.log(`Complete: ${config.output}\n${encodedFrames} verified frames · ${encodedDuration.toFixed(3)}s · ${config.width} × ${config.height} · ${config.fps} fps · H.264 + AAC`);
}

run().then(() => finish(0), (error) => finish(1, error));
