import crypto from 'node:crypto';

/**
 * Multi-user auth rules, kept pure so they can be tested without a database.
 * Adapted from event-scout's single-password auth.ts: scrypt hashing, an
 * HMAC-signed cookie and per-IP lockout are the same idea, but the cookie now
 * carries a user id and role instead of standing for one shared password.
 */

export const SESSION_COOKIE = 'ls_session';

export type Role = 'admin' | 'contributor';
export type Visibility = 'private' | 'unlisted' | 'public';
export type InstanceMode = 'private' | 'public';

export interface SessionUser {
  id: string;
  role: Role;
}

/** Signing in, signing up and first-run cannot themselves require a session. */
const OPEN_ROUTES = new Set([
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/status',
  '/api/auth/setup',
  '/api/auth/signup',
  '/api/version',
]);

export function normalizePath(p: string): string {
  const withoutQuery = p.split('?')[0].toLowerCase();
  const trimmed = withoutQuery.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Whether a request needs a signed-in session at all.
 *
 * private: every route needs one, GETs included. public: writes always need
 * one; reads don't, because an anonymous GET is filtered to public rows by
 * `canRead` instead of refused outright.
 */
export function needsAuth(method: string, path: string, mode: InstanceMode): boolean {
  const normalized = normalizePath(path);
  if (OPEN_ROUTES.has(normalized)) return false;
  // A share token is itself the credential; `/api/shares` (plural, managing
  // your own links) is a different, protected route.
  if (normalized.startsWith('/api/share/')) return false;
  if (method === 'GET' || method === 'HEAD') return mode === 'private';
  return true;
}

/**
 * Whether `user` may read a row with this visibility and owner.
 *
 * `unlisted` is deliberately as open as `public` here: the plan is that an
 * unlisted row is reachable by anyone holding its id, and never appears in a
 * list. Excluding it from lists is a separate filter (see `listWhere`
 * in index.ts) — this function only answers "can this one row be read".
 */
export function canRead(visibility: Visibility, ownerId: string, user: SessionUser | null): boolean {
  if (visibility === 'public' || visibility === 'unlisted') return true;
  if (!user) return false;
  return user.role === 'admin' || user.id === ownerId;
}

/** Contributors edit only their own rows; the admin edits everything. */
export function canEdit(ownerId: string, user: SessionUser | null): boolean {
  if (!user) return false;
  return user.role === 'admin' || user.id === ownerId;
}

function scryptHash(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
export { scryptHash };

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString('hex');
  return { hash: scryptHash(password, salt), salt };
}

/** Compare without leaking how far the comparison got. */
export function secureEqual(a: string, b: string): boolean {
  const ah = crypto.createHash('sha256').update(a, 'utf8').digest();
  const bh = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ah, bh);
}

/** `<userId>.<role>.<expiry>.<hmac>`, the hmac covering everything before it. */
export function signSession(userId: string, role: Role, expiresAt: number, secret: Buffer): string {
  const payload = `${userId}.${role}.${expiresAt}`;
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function verifySession(token: string | undefined, secret: Buffer, now = Date.now()): SessionUser | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [userId, role, expiryStr, mac] = parts;
  const payload = `${userId}.${role}.${expiryStr}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry <= now) return null;
  if (role !== 'admin' && role !== 'contributor') return null;
  return { id: userId, role };
}

/** Pull one cookie out of a Cookie header, without a parser dependency. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export const SESSION_DAYS = 30;

// --- brute force --------------------------------------------------------

/** A small, deliberately unsophisticated brake on password guessing, per IP. */
export const FREE_ATTEMPTS = 5;
export const LOCKOUT_MS = 30_000;
export const MAX_ATTEMPTS = 10_000;

interface AttemptEntry {
  count: number;
  until: number;
  lastAttempt: number;
}

const attempts = new Map<string, AttemptEntry>();

export function pruneAttempts(now = Date.now()): void {
  for (const [key, entry] of attempts) {
    if (now - entry.lastAttempt > LOCKOUT_MS * 2 && entry.until <= now) attempts.delete(key);
  }
}

export function loginBlockedFor(ip: string, now = Date.now()): number {
  const entry = attempts.get(ip);
  if (!entry) return 0;
  if (now - entry.lastAttempt > LOCKOUT_MS * 2 && entry.until <= now) {
    attempts.delete(ip);
    return 0;
  }
  if (entry.until > 0 && entry.until <= now) {
    entry.count = 0;
    entry.until = 0;
    return 0;
  }
  if (entry.until <= now) return 0;
  return entry.until - now;
}

export function noteLoginFailure(ip: string, now = Date.now()): void {
  pruneAttempts(now);
  if (!attempts.has(ip) && attempts.size >= MAX_ATTEMPTS) {
    const oldest = attempts.keys().next().value;
    if (oldest !== undefined) attempts.delete(oldest);
  }
  const entry = attempts.get(ip) ?? { count: 0, until: 0, lastAttempt: now };
  if (entry.until > 0 && entry.until <= now) {
    entry.count = 0;
    entry.until = 0;
  }
  if (now - entry.lastAttempt > LOCKOUT_MS) {
    entry.count = 0;
    entry.until = 0;
  }
  entry.count++;
  entry.lastAttempt = now;
  if (entry.count > FREE_ATTEMPTS) entry.until = now + LOCKOUT_MS;
  attempts.delete(ip);
  attempts.set(ip, entry);
}

export function noteLoginSuccess(ip: string): void {
  attempts.delete(ip);
}

export function _resetAttemptsForTest(): void {
  attempts.clear();
}
