/**
 * Overpass with fallbacks: the public instances rate-limit (429), time out (504) or are simply down often
 * enough that a single endpoint made building shade "unavailable" most of the time. Try each mirror in
 * turn (OVERPASS_URL first when set), retrying once on a transient status before moving on.
 */
export const OVERPASS_MIRRORS = [
  ...(process.env.OVERPASS_URL ? [process.env.OVERPASS_URL] : []),
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
].filter((u, i, a) => a.indexOf(u) === i);

const TRANSIENT = new Set([429, 502, 503, 504]);

export async function overpassQuery<T>(query: string, opts: { timeoutMs?: number; mirrors?: string[]; fetchImpl?: typeof fetch; retryDelayMs?: number } = {}): Promise<T> {
  const { timeoutMs = 25_000, mirrors = OVERPASS_MIRRORS, fetchImpl = fetch, retryDelayMs = 1000 } = opts;
  const errors: string[] = [];
  for (const url of mirrors) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'location-scout' },
          body: `data=${encodeURIComponent(query)}`,
          signal: controller.signal,
        });
        if (res.ok) {
          const body = await res.text();
          // Overpass sometimes answers 200 with an HTML/XML error page (e.g. "runtime error: timeout")
          try { return JSON.parse(body) as T; } catch { throw new Error('non-JSON response'); }
        }
        errors.push(`${new URL(url).host} ${res.status}`);
        if (!TRANSIENT.has(res.status)) break;
      } catch (err) {
        errors.push(`${new URL(url).host} ${(err as Error).name === 'AbortError' ? 'timeout' : (err as Error).message}`);
        if ((err as Error).name === 'AbortError') break; // a slow mirror won't get faster; try the next one
      } finally {
        clearTimeout(timer);
      }
      if (attempt === 0 && retryDelayMs) await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  throw new Error(`Overpass unavailable (${errors.join('; ')})`);
}
