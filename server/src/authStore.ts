import crypto from 'node:crypto';
import { Db } from './db.js';
import { Role, SessionUser, hashPassword, scryptHash, secureEqual, signSession, verifySession, SESSION_DAYS } from './auth.js';

/**
 * The half of auth that reaches the database: users, sessions and the
 * ADMIN_PASSWORD boot seed. Kept apart from auth.ts so the pure rules can be
 * tested without opening one, same split as event-scout's authStore.ts.
 */

export interface User {
  id: string;
  username: string;
  role: Role;
  created_at: string;
}

function row(db: Db, id: string): (User & { pw_hash: string; pw_salt: string }) | undefined {
  return db.handle.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
}

export function userCount(db: Db): number {
  return (db.handle.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
}

export function findUserByUsername(db: Db, username: string): (User & { pw_hash: string; pw_salt: string }) | undefined {
  return db.handle.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
}

export function findUserById(db: Db, id: string): User | undefined {
  const u = row(db, id);
  return u ? { id: u.id, username: u.username, role: u.role, created_at: u.created_at } : undefined;
}

export function listUsers(db: Db): User[] {
  return db.handle.prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at').all() as unknown as User[];
}

export function createUser(db: Db, username: string, password: string, role: Role): User {
  const { hash, salt } = hashPassword(password);
  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();
  db.handle
    .prepare('INSERT INTO users (id, username, pw_hash, pw_salt, role, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, username, hash, salt, role, created_at);
  return { id, username, role, created_at };
}

export function setUserRole(db: Db, id: string, role: Role): void {
  db.handle.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
}

export function setUserPassword(db: Db, id: string, password: string): void {
  const { hash, salt } = hashPassword(password);
  db.handle.prepare('UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?').run(hash, salt, id);
}

export function deleteUser(db: Db, id: string): void {
  db.handle.prepare('DELETE FROM users WHERE id = ?').run(id);
}

export function checkUserPassword(db: Db, username: string, password: string): User | null {
  const u = findUserByUsername(db, username);
  if (!u) return null;
  if (!secureEqual(scryptHash(password, u.pw_salt), u.pw_hash)) return null;
  return { id: u.id, username: u.username, role: u.role, created_at: u.created_at };
}

/**
 * `ADMIN_PASSWORD` seeds a user called `admin` on boot, for a container that
 * should come up locked down without anyone visiting the first-run wizard.
 * A no-op once any user exists, so it never resets a password set later.
 */
export function seedAdminFromEnv(db: Db): void {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return;
  if (userCount(db) > 0) return;
  createUser(db, 'admin', password, 'admin');
}

// --- sessions -------------------------------------------------------------

function sessionSecret(db: Db): Buffer {
  let hex = db.getKv('authSessionSecret');
  if (!hex) {
    hex = crypto.randomBytes(32).toString('hex');
    db.setKv('authSessionSecret', hex);
  }
  return Buffer.from(hex, 'hex');
}

export function newSessionToken(db: Db, user: SessionUser): { token: string; maxAgeMs: number } {
  const maxAgeMs = SESSION_DAYS * 24 * 3600 * 1000;
  return { token: signSession(user.id, user.role, Date.now() + maxAgeMs, sessionSecret(db)), maxAgeMs };
}

export function sessionUser(db: Db, token: string | undefined): SessionUser | null {
  return verifySession(token, sessionSecret(db));
}
