// Local UI test environment only. Never deploy this script as the server entry point.
import { createApp } from '../server/index.mjs';
import { createUser } from '../server/store.mjs';
import { resolve } from 'node:path';
const app = createApp({ dataDir: resolve('test-results/preview-data') });
if (!app.db.prepare('SELECT id FROM users WHERE username=?').get('preview')) await createUser(app.db, 'preview', 'Preview-Only-2026!', 'admin');
app.server.listen(8787, '127.0.0.1', () => console.log('Local preview: http://127.0.0.1:8787 — preview / Preview-Only-2026! (test account only)'));
