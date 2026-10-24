import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
export const digest = value => createHash('sha256').update(value).digest('hex');
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}
export async function verifyPassword(password, hash) {
  const [salt, expected] = hash.split(':');
  const actual = await scrypt(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
export function openStore(dataDir) {
  mkdirSync(join(dataDir, 'files'), { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'jianjian.sqlite'));
  db.exec(`
    PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
      enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      client_key TEXT NOT NULL, name TEXT NOT NULL, platform TEXT NOT NULL,
      last_seen INTEGER NOT NULL, UNIQUE(user_id, client_key)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      device_id TEXT NOT NULL REFERENCES devices(id), expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL REFERENCES users(id), device_id TEXT NOT NULL REFERENCES devices(id),
      kind TEXT NOT NULL, text TEXT, filename TEXT, size INTEGER,
      created_at INTEGER NOT NULL, expires_at INTEGER, expired INTEGER NOT NULL DEFAULT 0,
      client_id TEXT NOT NULL, UNIQUE(user_id, device_id, client_id)
    );
    CREATE INDEX IF NOT EXISTS messages_user_seq ON messages(user_id, seq DESC);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO settings VALUES ('maxFileMB', '500');
    INSERT OR IGNORE INTO settings VALUES ('retentionDays', '7');
    INSERT OR IGNORE INTO settings VALUES ('userQuotaMB', '5120');
  `);
  return db;
}
export function config(db) {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, Number(r.value)]));
}
export async function createUser(db, username, password, role = 'user') {
  if (!/^[a-zA-Z0-9_.@-]{3,64}$/.test(username)) throw new Error('账号需为 3–64 位字母、数字或 _.@-');
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('密码需为 12–256 位');
  const user = { id: randomUUID(), username, role, created_at: Date.now() };
  db.prepare('INSERT INTO users (id,username,password_hash,role,created_at) VALUES (?,?,?,?,?)')
    .run(user.id, username, await hashPassword(password), role, user.created_at);
  return user;
}
