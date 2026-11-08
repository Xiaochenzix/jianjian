import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const tailwind = join(dirname(require.resolve('@tailwindcss/cli/package.json')), 'dist/index.mjs');
const esbuild = join(dirname(require.resolve('esbuild/package.json')), 'bin/esbuild');
function run(command, args) {
  const result = spawnSync(process.execPath, [command, ...args], { stdio: 'inherit' });
  if (result.status) process.exit(result.status ?? 1);
}
run(tailwind, ['-i', 'web/src/glass.css', '-o', 'web/glass-login.css', '--minify']);
run(esbuild, ['web/src/glass-login.jsx', '--bundle', '--format=iife', '--outfile=web/glass-login.js', '--jsx=automatic', '--minify']);
run(tailwind, ['-i', 'web/src/beam.css', '-o', 'web/beam-login.css', '--minify']);
run(esbuild, ['web/src/beam-login.jsx', '--bundle', '--format=iife', '--outfile=web/beam-login.js', '--jsx=automatic', '--minify']);
run(esbuild, ['web/src/qr-global.js', '--bundle', '--format=iife', '--outfile=web/qr.js', '--minify']);
