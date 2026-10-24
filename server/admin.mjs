import { resolve } from 'node:path';
import { createUser, openStore } from './store.mjs';
const username = process.argv[2];
const password = process.env.JIANJIAN_ADMIN_PASSWORD;
if (!username || !password) {
  console.error('设置 JIANJIAN_ADMIN_PASSWORD 环境变量，再运行 npm run admin -- <账号>。密码至少 12 位。');
  process.exit(1);
}
const db = openStore(resolve(process.env.DATA_DIR || 'data'));
try {
  const user = await createUser(db, username, password, 'admin');
  console.log(`已创建管理员：${user.username}`);
} finally { db.close(); }
