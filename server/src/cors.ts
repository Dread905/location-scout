import { InstanceMode, needsAuth } from './auth.js';

/**
 * Cross-origin reads, for the origins the operator named. Adapted from
 * event-scout's cors.ts — same shape, `needsAuth` now also takes the
 * instance mode since what's open differs between private and public.
 */

const ALLOWED_METHODS = 'GET, HEAD, OPTIONS';
const EXPOSED = 'X-Total-Count, ETag';
const ALLOWED_HEADERS = 'Content-Type, If-None-Match';
const MAX_AGE = '600';

function normalise(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, '');
}

export function matchOrigin(origin: string | undefined, allowed: string[]): string | null {
  if (!origin) return null;
  const want = normalise(origin);
  if (!want || want === 'null') return null;
  for (const entry of allowed) {
    const e = normalise(entry);
    if (e === '*' || e === want) return origin;
  }
  return null;
}

export interface CorsRequest {
  origin: string | undefined;
  method: string;
  path: string;
  requestMethod?: string;
}

export interface CorsDecision {
  headers: Record<string, string>;
  vary: string;
  preflight: boolean;
}

export function corsDecision(req: CorsRequest, allowed: string[], mode: InstanceMode): CorsDecision | null {
  if (allowed.length === 0) return null;
  const origin = matchOrigin(req.origin, allowed);
  if (!origin) return null;

  const preflight = req.method === 'OPTIONS' && Boolean(req.requestMethod);
  const method = preflight ? req.requestMethod! : req.method;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return null;
  if (needsAuth(method, req.path, mode)) return null;

  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': EXPOSED,
  };
  if (preflight) {
    headers['Access-Control-Allow-Methods'] = ALLOWED_METHODS;
    headers['Access-Control-Allow-Headers'] = ALLOWED_HEADERS;
    headers['Access-Control-Max-Age'] = MAX_AGE;
  }
  return { headers, vary: 'Origin', preflight };
}

export function readOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const entry = raw.trim();
    if (!entry) continue;
    if (entry === '*') {
      out.push('*');
      continue;
    }
    try {
      const url = new URL(entry);
      if (!/^https?:$/.test(url.protocol)) continue;
      out.push(`${url.protocol}//${url.host}`);
    } catch {
      // Not a URL at all. Dropped rather than guessed at.
    }
  }
  return [...new Set(out)];
}
