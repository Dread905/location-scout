/**
 * Shared reusable OpenStreetMap Overpass client.
 * Features:
 * - Configurable ordered endpoints with canonical default first and safe validation.
 * - Sequential failover and capped retries only for transient errors (network, timeout, 429, 5xx).
 * - Immediate failure without retry on non-retryable 4xx query errors.
 * - Structured, redacted diagnostics without secrets or query bodies.
 */

export const DEFAULT_OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

export interface OverpassDiagnostic {
  endpoint: string; // Hostname only, no credentials/paths/queries
  errorClass: 'network' | 'timeout' | 'http' | 'parse';
  status?: number;
  attempts: number;
  category?: string;
  hint: string;
}

export class OverpassError extends Error {
  public readonly diagnostic: OverpassDiagnostic;

  constructor(diagnostic: OverpassDiagnostic, extraMessage?: string) {
    const detail = extraMessage ? `: ${extraMessage}` : '';
    super(
      `[${diagnostic.category ?? 'overpass'}] ${diagnostic.endpoint} failed (${diagnostic.errorClass}${
        diagnostic.status ? ` ${diagnostic.status}` : ''
      }, ${diagnostic.attempts} attempt${diagnostic.attempts === 1 ? '' : 's'})${detail}. Hint: ${diagnostic.hint}`
    );
    this.name = 'OverpassError';
    this.diagnostic = diagnostic;
  }
}

/**
 * Validates an Overpass endpoint URL.
 * Throws if the URL is invalid or scheme is not http/https.
 */
export function validateOverpassEndpoint(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid Overpass endpoint URL: "${rawUrl}"`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `Invalid Overpass endpoint URL: "${rawUrl}". URL scheme must be http: or https:`
    );
  }

  return url.toString();
}

/**
 * Resolves an ordered list of validated Overpass endpoints.
 * Prioritizes OVERPASS_ENDPOINTS, falls back to legacy OVERPASS_URL,
 * and defaults to DEFAULT_OVERPASS_ENDPOINT.
 */
export function resolveOverpassEndpoints(
  envEndpoints?: string,
  legacyUrl?: string
): string[] {
  const endpointsStr = envEndpoints ?? process.env.OVERPASS_ENDPOINTS;
  if (endpointsStr && endpointsStr.trim()) {
    const list = endpointsStr
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entry) => validateOverpassEndpoint(entry));

    if (list.length > 0) {
      return list;
    }
  }

  const legacy = legacyUrl ?? process.env.OVERPASS_URL;
  if (legacy && legacy.trim()) {
    return [validateOverpassEndpoint(legacy)];
  }

  return [DEFAULT_OVERPASS_ENDPOINT];
}

export const DEFAULT_OVERPASS_PACE_MS = 1000;

/**
 * Resolves the request pacing interval in milliseconds.
 * Checks OVERPASS_PACE_MS, falls back to OVERPASS_MIN_INTERVAL_MS,
 * and defaults to DEFAULT_OVERPASS_PACE_MS (1000ms).
 * Values <= 0 or non-finite resolve to DEFAULT_OVERPASS_PACE_MS.
 */
export function resolveOverpassPaceMs(envPace?: string | number): number {
  const raw = envPace ?? process.env.OVERPASS_PACE_MS ?? process.env.OVERPASS_MIN_INTERVAL_MS;
  if (raw !== undefined) {
    const parsed = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : NaN);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_OVERPASS_PACE_MS;
}

export interface OverpassClientOptions {
  endpoints?: string[];
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  maxRetriesPerEndpoint?: number;
  paceMs?: number;
  minRequestIntervalMs?: number;
}

export interface OverpassQueryOptions {
  category?: string;
  timeoutMs?: number;
}

export class OverpassClient {
  public readonly endpoints: string[];
  public readonly paceMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly nowFn: () => number;
  private readonly defaultTimeoutMs: number;
  private readonly maxRetriesPerEndpoint: number;
  private lastRequestTime: number | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: OverpassClientOptions = {}) {
    this.endpoints = options.endpoints && options.endpoints.length > 0
      ? options.endpoints.map(validateOverpassEndpoint)
      : resolveOverpassEndpoints();
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.sleepFn = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.nowFn = options.now ?? (() => Date.now());
    this.defaultTimeoutMs = options.timeoutMs ?? 25_000;
    this.maxRetriesPerEndpoint = options.maxRetriesPerEndpoint ?? 1;
    const explicitPace = (options.paceMs !== undefined && Number.isFinite(options.paceMs) && options.paceMs > 0)
      ? options.paceMs
      : (options.minRequestIntervalMs !== undefined && Number.isFinite(options.minRequestIntervalMs) && options.minRequestIntervalMs > 0)
        ? options.minRequestIntervalMs
        : (options.paceMs ?? options.minRequestIntervalMs);
    this.paceMs = resolveOverpassPaceMs(explicitPace);
  }

  /**
   * Safely extracts the host (hostname:port if non-standard) without auth or paths.
   */
  private safeHost(endpoint: string): string {
    try {
      return new URL(endpoint).host;
    } catch {
      return 'unknown-host';
    }
  }

  /**
   * Pacing gate enforcing the minimum request interval across all fetch attempts,
   * while accommodating any retry backoff delay.
   */
  private async waitPace(extraDelay = 0): Promise<void> {
    let wait = extraDelay;
    if (this.lastRequestTime !== null && this.paceMs > 0) {
      const elapsed = this.nowFn() - this.lastRequestTime;
      const paceWait = this.paceMs - elapsed;
      if (paceWait > wait) {
        wait = paceWait;
      }
    }
    if (wait > 0) {
      await this.sleepFn(wait);
    }
  }

  async query<T = any>(
    ql: string,
    options?: OverpassQueryOptions
  ): Promise<{ elements: T[] }> {
    const execute = () => this.executeRequest<T>(ql, options);
    const next = this.queue.then(execute, execute);
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  private async executeRequest<T = any>(
    ql: string,
    options?: OverpassQueryOptions
  ): Promise<{ elements: T[] }> {
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const category = options?.category;
    let attemptCount = 0;
    let lastError: OverpassError | null = null;

    for (const endpoint of this.endpoints) {
      const host = this.safeHost(endpoint);

      for (let retriesOnEndpoint = 0; retriesOnEndpoint <= this.maxRetriesPerEndpoint; retriesOnEndpoint++) {
        attemptCount++;

        let retryDelay = 0;
        if (retriesOnEndpoint > 0) {
          retryDelay = Math.min(2000, 300 * Math.pow(2, retriesOnEndpoint - 1)) + Math.floor(Math.random() * 100);
        }
        await this.waitPace(retryDelay);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const res = await this.fetchFn(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `data=${encodeURIComponent(ql)}`,
            signal: controller.signal,
          });
          clearTimeout(timer);
          this.lastRequestTime = this.nowFn();

          if (res.ok) {
            let text: string;
            try {
              text = await res.text();
            } catch (readErr) {
              const diag: OverpassDiagnostic = {
                endpoint: host,
                errorClass: 'network',
                attempts: attemptCount,
                category,
                hint: 'Network connection failed while reading response. Verify internet access or configure an alternative OVERPASS_ENDPOINTS mirror.',
              };
              lastError = new OverpassError(diag, (readErr as Error)?.message);
              continue;
            }

            let data: any;
            try {
              data = JSON.parse(text);
            } catch {
              const parseDiag: OverpassDiagnostic = {
                endpoint: host,
                errorClass: 'parse',
                attempts: attemptCount,
                category,
                hint: 'Invalid JSON response from Overpass. The server may have returned an HTML error page.',
              };
              throw new OverpassError(parseDiag, 'Failed to parse JSON response');
            }

            if (!data || !Array.isArray(data.elements)) {
              const parseDiag: OverpassDiagnostic = {
                endpoint: host,
                errorClass: 'parse',
                attempts: attemptCount,
                category,
                hint: 'Invalid JSON response from Overpass. The server may have returned an HTML error page.',
              };
              throw new OverpassError(parseDiag, 'Response missing elements array');
            }

            return data as { elements: T[] };
          }

          const status = res.status;
          if (status === 429 || status >= 500) {
            // Transient HTTP error: retryable
            const hint =
              status === 429
                ? 'Rate limited by Overpass (HTTP 429). Wait before retrying or configure an additional mirror.'
                : `Overpass server error (HTTP ${status}). The upstream mirror may be overloaded; try again later or add a mirror.`;
            const diag: OverpassDiagnostic = {
              endpoint: host,
              errorClass: 'http',
              status,
              attempts: attemptCount,
              category,
              hint,
            };
            lastError = new OverpassError(diag, `HTTP ${status}`);
            continue;
          }

          // Non-retryable HTTP 4xx: do not retry, do not failover!
          let hint = `Overpass returned HTTP ${status}. Check endpoint availability or query.`;
          if (status === 400) {
            hint = 'Overpass rejected query syntax or area too large (HTTP 400). Check query or reduce area radius.';
          }
          const nonRetryableDiag: OverpassDiagnostic = {
            endpoint: host,
            errorClass: 'http',
            status,
            attempts: attemptCount,
            category,
            hint,
          };
          throw new OverpassError(nonRetryableDiag, `HTTP ${status}`);
        } catch (err: unknown) {
          clearTimeout(timer);
          this.lastRequestTime = this.nowFn();
          if (err instanceof OverpassError) {
            throw err;
          }

          const isAbort = (err as any)?.name === 'AbortError' || controller.signal.aborted;
          const errorClass = isAbort ? 'timeout' : 'network';
          const hint = isAbort
            ? 'Request timed out. Consider reducing the area radius or configuring an OVERPASS_ENDPOINTS mirror.'
            : 'Network connection failed. Verify internet access or configure an alternative OVERPASS_ENDPOINTS mirror.';

          const diag: OverpassDiagnostic = {
            endpoint: host,
            errorClass,
            attempts: attemptCount,
            category,
            hint,
          };
          lastError = new OverpassError(diag, (err as Error)?.message);
          continue;
        }
      }
    }

    if (lastError) {
      // Re-create with total attempts across all endpoints
      throw new OverpassError(
        {
          ...lastError.diagnostic,
          attempts: attemptCount,
        },
        'All configured endpoints exhausted'
      );
    }

    throw new Error('No Overpass endpoints configured');
  }
}
