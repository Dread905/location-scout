import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * SSRF guard for remotes and share syncs: http(s) only, private/loopback/
 * link-local addresses blocked unless the operator opted in for a LAN setup.
 */

/** Pure classifier, so the IP ranges can be tested without a network. */
export function isPrivateIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    return false;
  }
  if (kind === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80:') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local, fc00::/7
    // IPv4-mapped: ::ffff:a.b.c.d
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true; // not a recognisable IP at all: refuse rather than guess
}

export class SsrfError extends Error {}

/**
 * Resolve `url`'s host and refuse it unless every address is public (or the
 * caller allows private ones, for a LAN remote). Returns the parsed URL.
 */
export async function assertPublicUrl(rawUrl: string, allowPrivate = false): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError('Not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfError('Only http(s) URLs are allowed');
  if (allowPrivate) return url;

  const literal = net.isIP(url.hostname) ? url.hostname : null;
  const addresses = literal ? [literal] : (await dns.lookup(url.hostname, { all: true })).map((a) => a.address);
  if (addresses.length === 0) throw new SsrfError('Could not resolve host');
  for (const addr of addresses) {
    if (isPrivateIp(addr)) throw new SsrfError(`${url.hostname} resolves to a private address`);
  }
  return url;
}

const FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_BYTES = 25 * 1024 * 1024;

/** A guarded fetch: SSRF-checked, timed out, and capped in size. */
export async function guardedFetch(rawUrl: string, allowPrivate = false): Promise<Buffer> {
  const url = await assertPublicUrl(rawUrl, allowPrivate);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    const contentLength = Number(res.headers.get('content-length') ?? '0');
    if (contentLength > MAX_FETCH_BYTES) throw new Error('Response too large');
    const reader = res.body?.getReader();
    if (!reader) return Buffer.from(await res.arrayBuffer());
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_FETCH_BYTES) throw new Error('Response too large');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}
