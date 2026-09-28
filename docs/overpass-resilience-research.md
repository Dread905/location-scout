# Overpass Resilience Research — 2026-09-27

## Observed failure

The **Rail network** and **Candidate spots** startup tasks both failed with `fetch failed`.

They share the same code path: each sends OSM Overpass requests through the default `https://overpass-api.de/api/interpreter` endpoint. The saved task records show:

- `rail-network`: `failed: fetch failed`
- `candidates`: `failed: fetch failed`
- TfNSW static timetable tasks succeeded, so this is not a general application or TfNSW connectivity failure.

The configured home area is Bathurst with a 100 km radius.

## Local probe findings

### Runtime transport

- Node 22 `fetch` to the default Overpass endpoint timed out before a usable response (`ETIMEDOUT`, plus unreachable IPv6 attempts), even for a tiny query.
- Curl reached the default endpoint but received HTTP 406.
- The `maps.mail.ru` Overpass mirror returned HTTP 200 to Node for a small request.
- `overpass.osm.ch` returned HTTP 200 to curl but still timed out from this Node runtime.

Conclusion: a hard-coded single endpoint makes the feature unavailable when that endpoint is unreachable from a particular runtime. A mirror must be configurable, and retry/failover needs clear diagnostics.

### Query size and shape

The current Bathurst home area produces a roughly 200 km × 200 km bounding box.

Against a reachable mirror:

- The rail-line query completed in about 24 seconds and returned 1,055 ways.
- The industrial query and candidate query returned gateway/runtime errors at the 100 km radius.
- The candidate query contains two broad `abandoned`/`disused` key-regex clauses, which are likely expensive over a large region.

Conclusion: an endpoint fallback alone is insufficient. The importer must keep requests bounded and serial, split large areas into smaller tiles, and expose the failing query phase without exposing full query text or sensitive configuration.

## Recommended implementation direction

1. Introduce a reusable Overpass client with an ordered endpoint list.
2. Keep the canonical endpoint first, allow operators to configure comma-separated mirrors, and never silently send parallel bursts to mirrors.
3. Retry only transient network, 429, 5xx, and timeout failures with a short capped backoff; do not retry 4xx query errors.
4. Split large configured areas into bounded tiles and execute tiles sequentially.
5. Split the candidate discovery query into smaller semantic groups; retain current discovery coverage while preventing one broad query from failing the whole task.
6. Preserve last-known-good rail/candidate data when refresh fails.
7. Record safe structured diagnostics: endpoint host, phase/category, HTTP status or error class, attempt count, elapsed time, and a human-readable remediation hint. Never persist API keys or full query bodies.
8. Cover the client, tiling, fallback, retry classification, and stale-data behavior with deterministic tests using injected fetch behavior.

## Non-recommendations

- Do not claim a public Overpass mirror is guaranteed or permanently reliable.
- Do not issue parallel tile requests or unbounded retries.
- Do not replace OSM data with a different provider just to hide the transport failure.
- Do not treat `fetch failed` as a useful final user-facing diagnostic.
