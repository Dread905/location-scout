# Location Scout

A self-hosted map of your favourite photography spots and when the light works there — golden and blue hour, sun and moon alignment, good-times filters. Phase 1: auth, data model, CRUD API, photos, import/export, sharing between instances, Docker. Phase 2: the MapLibre map with sun, moon, hillshade and building-shadow layers on a time slider, place/spot editing, alignments, the trip planner and the import/export UI. Phase 3 adds live planes, trains and Event Scout integration.

Same stack as [event-scout](../event-scout): TypeScript, Node 24, Express, `node:sqlite`, React 19 + Vite, npm workspaces.

## Run it

```bash
npm install
npm run dev      # server on :3003, web dev server on :5174 (proxies /api to :3003)
```

Or with Docker:

```bash
docker compose up --build
```

Open http://localhost:3003 (or :5174 in dev) and create the admin account on first run, or set `ADMIN_PASSWORD` before first boot to seed it without the wizard.

## Reaching event-scout from a container

If event-scout runs in its own compose stack, either put both on a shared external Docker network and set `EVENT_SCOUT_URL` to its service name, or point it at `http://host.docker.internal:<port>` if it runs on the host.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `API_PORT` | `3003` | Port the server listens on. |
| `INSTANCE_MODE` | `private` | `private`: every route needs a login. `public`: anonymous visitors see public spots only. |
| `ADMIN_PASSWORD` | — | Seeds a user `admin` with this password on first boot, if no user exists yet. |
| `TRUST_PROXY` | — | Behind a reverse proxy, the number of hops to trust `X-Forwarded-For` from. |
| `TFNSW_API_KEY` | — | TfNSW Open Data key, for the trains feed (phase 3). |
| `EVENT_SCOUT_URL` | — | Base URL of an event-scout instance, for nearby events and busyness (phase 3). |
| `ADSB_URL` | `https://api.adsb.lol` | Planes feed base URL; point at airplanes.live if preferred (phase 3). |
| `TZ` | `Australia/Sydney` | Affects what counts as "today" and daily task timing. |

## API

Auth (`ADMIN_PASSWORD`/setup aside, everything below follows `INSTANCE_MODE`):

| Method | Path | Notes |
|---|---|---|
| GET | `/api/auth/status` | Whether setup is needed, who's signed in, whether sign-up is open. |
| POST | `/api/auth/setup` | First run only: create the admin. |
| POST | `/api/auth/signup` | Create a contributor account, if the admin allowed it. |
| POST | `/api/auth/login` / `/api/auth/logout` | Session cookie. |
| GET/POST | `/api/users` | Admin: list / create users. |
| PATCH/DELETE | `/api/users/:id` | Admin: change role or password, or remove a user. |
| GET/PUT | `/api/settings` | Home area, extra areas, sign-up toggle, remotes policy, feed URLs. PUT is admin-only. |
| GET | `/api/geocode?q=` | Nominatim search, cached. |
| GET | `/api/version` | Build info. |
| GET/POST | `/api/places` | List (visibility-filtered) / create. |
| GET/PATCH/DELETE | `/api/places/:id` | |
| GET/POST | `/api/spots` | `?bbox=s,w,n,e`, `?near=lat,lng&radiusKm=`, `?placeId=`. |
| GET/PATCH/DELETE | `/api/spots/:id` | `goodTimes` is validated: phases, months, days, conditions, event keywords, avoid, notes. |
| POST | `/api/spots/:id/photos` | Multipart `photo` + `thumb` (already resized in the browser); checked by magic bytes, capped at 15MB. |
| GET | `/api/photos/:id/file`, `/api/photos/:id/thumb` | Auth-checked against the parent spot's visibility. |
| GET | `/api/spots/:id/photos` | The spot's photos. |
| PATCH/DELETE | `/api/photos/:id` | PATCH takes `caption` and `kind`. |
| POST | `/api/import` | A GeoJSON FeatureCollection of places/spots; upserts by `source`+`sourceRef` when both are given. |
| GET | `/api/export.geojson`, `/api/export.gpx` | Your own places/spots/sightings, or waypoints. |
| GET/POST | `/api/shares` | List / create a share link (returns a token). |
| DELETE | `/api/shares/:token` | Revoke. |
| GET | `/api/share/:token` | The bundle the token grants — no login needed, the token is the credential. |
| GET/POST | `/api/remotes` | List / add a remote instance's share URL. |
| DELETE | `/api/remotes/:id` | |
| POST | `/api/remotes/:id/sync` | Fetch and upsert now, instead of waiting for the daily task. |
| GET | `/api/tasks` | Background task status and log. |
| POST | `/api/tasks/:name/run` | Admin: run a task now. |

Remotes are SSRF-guarded: http(s) only, private/loopback/link-local addresses blocked unless `allowPrivateRemotes` is set (for LAN setups).
