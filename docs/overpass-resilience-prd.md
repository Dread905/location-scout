# PRD — Resilient OSM Overpass Ingestion

## Problem Statement

Location Scout’s **Rail network** and **Candidate spots** features depend on OpenStreetMap Overpass data. Both fail when the hard-coded endpoint cannot be reached from the Node runtime, and the task panel only reports the unhelpful message `fetch failed`.

A large configured scouting area can also generate expensive Overpass queries. At the current Bathurst 100 km radius, rail data is near the existing timeout boundary and industrial/candidate queries fail at the upstream service. A retry against the same endpoint or a single mirror URL is not enough.

## Solution

Add a bounded, observable Overpass ingestion layer that can fail over between explicitly configured endpoints, keeps large work split into sequential tiles and smaller query categories, preserves the last successful data on refresh failure, and tells the operator what failed and what to do next.

The feature must remain polite to public Overpass services: no parallel fan-out, no aggressive retries, and no hidden background traffic increase.

## User Stories

1. As a Location Scout admin, I want rail and candidate refreshes to survive a transient endpoint failure, so the map is not dependent on one network route.
2. As an admin, I want to configure an ordered list of Overpass endpoints, so I can use an endpoint that works in my deployment environment.
3. As an admin, I want the canonical endpoint to remain the default first choice, so a fresh setup works without choosing a provider.
4. As an admin, I want the task panel to state whether a failure was network, timeout, HTTP status, parsing, or query-category related, so I know what to investigate.
5. As an admin, I want the failing endpoint host and retry count shown without secrets or whole request bodies, so diagnostics are useful and safe.
6. As an admin, I want a remediation hint when every endpoint fails, so I know whether to wait, configure a mirror, or reduce an area.
7. As a photographer, I want the last successful rail layer to remain visible when refresh fails, so a temporary source outage does not erase useful planning data.
8. As a photographer, I want candidate spots already imported to remain available when the next discovery refresh fails, so failures do not destroy prior work.
9. As an operator with a large home area, I want import work broken into bounded sequential tiles, so public Overpass services are less likely to reject one oversized request.
10. As an operator, I want candidate discovery split into smaller semantic categories, so one expensive category does not make all candidate imports fail.
11. As an operator, I want each tile and category processed serially, so Location Scout remains courteous to shared Overpass infrastructure.
12. As an operator, I want retries limited and delayed, so an outage does not create a request storm.
13. As a developer, I want deterministic tests for endpoint selection, retry classification, tiling, and stale-data behavior, so the feature can be changed without relying on live Overpass services.
14. As a contributor, I want the README/environment documentation to explain endpoint configuration and safe operational limits, so deployments can recover without code changes.

## Implementation Decisions

- Introduce one reusable Overpass client used by both rail and candidate ingestion.
- Support an ordered environment configuration for endpoint URLs. Preserve the existing canonical endpoint as the default. Allow an operator-provided ordered fallback list; validate URL scheme and reject empty/invalid entries.
- Fail over only for network errors, aborted/timeouts, HTTP 429, and HTTP 5xx. Do not retry ordinary 4xx query validation errors.
- Use a small, capped retry policy with exponential delay and jitter. Do not run endpoints or tiles in parallel.
- Enforce a conservative minimum interval between all successful or failed public Overpass requests made by one refresh, configurable for deployment but non-zero by default. This pacing applies across tiles and candidate categories, not only retry attempts.
- Give each client request a bounded timeout and include endpoint host, attempt count, error class, and safe status information in the returned diagnostic object.
- Split a configured circular area into bounded geographic tiles. Process tiles serially. Deduplicate resulting OSM features by OSM identity before storage.
- Keep rail-line, industrial/mine, and candidate discovery calls independently bounded. Split candidate discovery into explicit query categories, including the existing abandoned/disused discovery category, so failures name the category that failed.
- Preserve existing cached rail GeoJSON and existing candidate rows if a full refresh fails. Do not overwrite them with empty partial output.
- Surface a concise safe diagnostic in task results and logs. Do not store API keys, full request bodies, or credentials.
- Keep the external API contract compatible where practical. Any richer task status fields must remain additive.
- Document the operational rule: configure a working endpoint list for the deployment, use reasonable area radii, and do not schedule repeated manual refreshes while a task is running.

## Testing Decisions

- Add focused test seams around the Overpass client by injecting fetch and time/sleep behavior; tests must not call live Overpass services.
- Strict TDD is required: each production behavior begins with a focused failing test, then the minimal implementation, then the full suite.
- Test endpoint ordering, invalid endpoint configuration, transient failover, no retry on non-retryable 4xx, retry cap, and diagnostics redaction.
- Test that parse failures are reported without retry/failover, because retry eligibility is limited to network, timeout, HTTP 429, and HTTP 5xx failures.
- Test that normal sequential queries honour the configured minimum request interval, not only retry delays.
- Test tiling produces bounded tiles that cover the requested area and that the scheduler processes them serially.
- Test per-category candidate ingestion reports the category when it fails.
- Test deduplication across tiles and preservation of last-known-good rail/candidate data after a failed refresh.
- Extend existing rail/candidate pure-mapping tests rather than replacing them.
- Run the full workspace test suite and TypeScript type-check. Perform a local smoke check using a controlled fake client or configured endpoint only; do not make a live public-service query a required automated test.

## Out of Scope

- Building or operating a private Overpass instance.
- Guaranteeing availability of any public Overpass endpoint or mirror.
- Replacing OSM/Overpass with a paid map-data provider.
- Increasing refresh frequency beyond the existing weekly cadence.
- Public freight live tracking, freight timetable parsing, or TfNSW feed changes.
- Broad redesign of the map UI beyond safe task-status diagnostics.

## Further Notes

- Research evidence and local probes are recorded in `overpass-resilience-research.md`.
- Local probes showed both endpoint reachability and query size matter. The implementation must solve both rather than hard-coding a new mirror URL.
- Working folder: `/root/.hermes/projects/location-scout`
- Implementation branch: `scott/overpass-resilience`
