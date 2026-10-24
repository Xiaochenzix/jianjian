import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const help = `Render the Jianjian music video locally using Electron and FFmpeg.

  npm run mv:render
  npm run mv:render -- --width 1280 --height 720 --fps 30
  npm run mv:render -- --frames 3,11,19,27,35,43

Options:
  --width N       Canvas width, even integer (default 1920)
  --height N      Canvas height, even integer (default 1080)
  --fps N         Frames per second, 1–120 (default 30)
  --output PATH   MP4 output (default releases/jianjian-mv.mp4)
  --frames LIST   Only save PNGs at these times into test-results/mv
  --help          Show this help

Set FFMPEG_PATH to an existing FFmpeg executable, or put ffmpeg on PATH.
An existing imageio_ffmpeg installation in python/python3 is also detected.
Optional local encoder: python -m pip install --target .tools/mv-python imageio-ffmpeg==0.6.0
Screenshot mode does not require FFmpeg.`;

function parseArgs(args) {
  const options = { width: 1920, height: 1080, fps: 30, duration: 48, output: join(root, 'releases', 'jianjian-mv.mp4') };
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (!['--width', '--height', '--fps', '--output', '--frames'].includes(argument)) throw new Error(`Unknown option: ${argument}. Use --help.`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
    if (argument === '--output') options.output = resolve(value);
    else if (argument === '--frames') {
      const values = value.split(',');
      options.frames = values.map(Number);
      if (values.some((entry) => !entry.trim()) || options.frames.some((time) => !Number.isFinite(time) || time < 0 || time >= options.duration)) {
        throw new Error('--frames must be a comma-separated list of seconds from 0 up to (but excluding) 48.');
      }
    } else options[argument.slice(2)] = Number(value);
  }
  for (const name of ['width', 'height']) {
    if (!Number.isInteger(options[name]) || options[name] < 16 || options[name] > 7680 || options[name] % 2) throw new Error(`--${name} must be an even integer from 16 to 7680.`);
  }
  if (!Number.isInteger(options.fps) || options.fps < 1 || options.fps > 120) throw new Error('--fps must be an integer from 1 to 120.');
  if (extname(options.output).toLowerCase() !== '.mp4') throw new Error('--output must end in .mp4.');
  return options;
}

function isFfmpeg(command) {
  const result = spawnSync(command, ['-version'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
  return result.status === 0 && /ffmpeg version/i.test(result.stdout);
}

function findFfmpeg() {
  if (process.env.FFMPEG_PATH) {
    if (isFfmpeg(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
    throw new Error(`FFMPEG_PATH does not point to a working FFmpeg executable: ${process.env.FFMPEG_PATH}`);
  }
  if (isFfmpeg('ffmpeg')) return 'ffmpeg';
  // Reuse a local tool if present. Never download an encoder or modify dependencies.
  const toolDirectory = join(root, '.tools');
  if (existsSync(toolDirectory)) {
    for (const entry of readdirSync(toolDirectory, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && /^ffmpeg(?:[-.].*)?(?:\.exe)?$/i.test(entry.name)) {
        const candidate = join(entry.parentPath, entry.name);
        if (isFfmpeg(candidate)) return candidate;
      }
    }
  }
  const pythonCandidates = [process.env.PYTHON, 'python', 'python3'].filter(Boolean);
  for (const python of pythonCandidates) {
    const result = spawnSync(python, ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    const candidate = result.status === 0 ? result.stdout.trim().split(/\r?\n/).at(-1) : '';
    if (candidate && isFfmpeg(candidate)) return candidate;
  }
  throw new Error('FFmpeg was not found. Install FFmpeg with H.264/AAC support and add it to PATH, or set FFMPEG_PATH to an existing ffmpeg.exe. To install a local encoder explicitly, run: python -m pip install --target .tools/mv-python imageio-ffmpeg==0.6.0. An existing Python imageio_ffmpeg installation is also supported (set PYTHON if needed). To inspect images without an encoder, use npm run mv:render -- --frames 3,11,19,27,35,43.');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return console.log(help);
  if (!existsSync(join(root, 'mv', 'film.js'))) throw new Error('Missing mv/film.js. Run this command from the complete Jianjian project.');
  options.root = root;
  options.frameDirectory = join(root, 'test-results', 'mv');
  if (!options.frames) options.ffmpeg = findFfmpeg();
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'jianjian-mv-'));
  options.temporaryOutput = join(dirname(options.output), `.${process.pid}-${Date.now()}-jianjian-mv.partial.mp4`);
  options.cancelFile = join(temporaryDirectory, 'cancel');
  let child;
  let forceStop;
  let cancelled = false;
  const interrupt = () => {
    cancelled = true;
    writeFileSync(options.cancelFile, 'cancel');
    // Let the worker close its encoder first, including on Windows where kill()
    // terminates a process immediately without delivering a graceful signal.
    forceStop ??= setTimeout(() => child?.kill(), 5000).unref();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    if (!options.frames) {
      mkdirSync(dirname(options.output), { recursive: true });
      options.audio = join(temporaryDirectory, 'score.wav');
      const { writeScore } = await import('./mv-audio.mjs');
      writeScore(options.audio, { duration: options.duration, sampleRate: 48000 });
      if (!existsSync(options.audio)) throw new Error('The music generator did not create score.wav.');
      console.log(`Rendering ${options.width} × ${options.height}, ${options.fps} fps, ${options.duration} seconds.\nFFmpeg: ${options.ffmpeg}`);
    } else console.log(`Saving ${options.frames.length} still frames at ${options.width} × ${options.height}.`);
    const configPath = join(temporaryDirectory, 'config.json');
    writeFileSync(configPath, JSON.stringify(options));
    if (cancelled) throw new Error('Rendering cancelled.');
    const environment = { ...process.env, JIANJIAN_MV_CONFIG: configPath };
    delete environment.ELECTRON_RUN_AS_NODE;
    child = spawn(require('electron'), [join(root, 'scripts', 'render-mv-worker.cjs')], {
      cwd: root, env: environment, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
    });
    const code = await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', (exitCode, signal) => signal ? reject(new Error(`Rendering interrupted (${signal}).`)) : resolveExit(exitCode));
    });
    if (code !== 0) throw new Error(`The renderer exited with code ${code}. See the diagnostic above.`);
  } finally {
    clearTimeout(forceStop);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    rmSync(temporaryDirectory, { recursive: true, force: true });
    rmSync(options.temporaryOutput, { force: true });
  }
}

main().catch((error) => { console.error(`MV render failed: ${error.message}`); process.exitCode = 1; });
