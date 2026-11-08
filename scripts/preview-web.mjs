import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

const root = new URL('../web/', import.meta.url);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const allowed = new Set(['index.html', 'styles.css', 'app.js', 'icon.svg', 'theme.js', 'qr.js', 'glass-login.js', 'glass-login.css', 'beam-login.js', 'beam-login.css']);
const port = Number(process.env.PORT || 8795);
createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  const file = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  if (!allowed.has(file)) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end(); return; }
  res.writeHead(200, { 'Content-Type': types[extname(file)], 'Cache-Control': 'no-store' });
  res.end(readFileSync(new URL(file, root)));
}).listen(port, '127.0.0.1', () => console.log(`preview http://127.0.0.1:${port}`));
