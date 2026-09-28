# Sun-Anchor Crosshair Research — 2026-09-28

## Existing implementation

Location Scout already calculates solar data from a chosen latitude/longitude in `web/src/map/sun.ts` using `suncalc`.

On the map page, the current display origin is selected by this precedence:

1. A spot draft being edited.
2. A selected saved spot.
3. The viewport centre, updated after MapLibre's `moveend` event.

That origin currently drives `updateRays()` (current sun, moon, sunrise and sunset rays) and `TimeBar`. A selected candidate or place is not currently included in this precedence, and a click on empty map clears selection and falls back to viewport centre.

`updateRays()` constructs GeoJSON line features from the origin. Ray length is derived from map metres-per-pixel so the display stays visually useful as zoom changes.

Map mood / hillshade / 3D-building light currently consume the same selected origin. Building and terrain shadows intentionally use `map.getCenter()` because they are calculated from the actual visible buildings and terrain.

## Existing reusable seam

`SpotEditor` already owns MapLibre `Marker` lifecycle correctly:

- creates markers only after a map exists;
- uses `draggable: true`;
- updates React state during drag;
- cleans markers and map listeners up on effect teardown.

This is the closest local pattern for a dedicated solar crosshair marker.

## External API research

MapLibre GL JS supports a custom DOM marker element with `draggable: true`, exposes `dragstart`, `drag`, and `dragend`, and supports `setLngLat`, `getLngLat`, and `remove` for lifecycle management. The official documentation also warns that a custom marker element owns its own accessibility: the application must provide tabindex, role, label, and keyboard movement rather than relying on default-marker behaviour.

Sources checked 2026-09-28:

- MapLibre official draggable-marker example: https://maplibre.org/maplibre-gl-js/docs/examples/create-a-draggable-marker/
- MapLibre official Marker API: https://maplibre.org/maplibre-gl-js/docs/API/classes/Marker/
- MapLibre official custom-marker example: https://maplibre.org/maplibre-gl-js/docs/examples/custom-marker-icons/

## Recommended direction

Introduce an ephemeral, user-controlled **sun anchor** represented by a draggable custom crosshair marker.

- A map-tool button enters explicit placement mode so normal click-to-select behavior is not changed.
- The next map click creates the anchor at that coordinate and exits placement mode.
- While present, the anchor has higher priority than spot drafts, selected spots, and the viewport centre for the sun-ray display and TimeBar.
- Dragging the crosshair updates the display continuously.
- A clear/follow-camera action removes the anchor and restores current fallback behavior.
- The anchor is in-memory only for this first slice; it is not written to the database, share links, URLs, or user settings.
- Viewport shadows remain driven by viewport centre. The feature is a planning/display origin, not a change to physical rendering of visible terrain.

## Risks and guardrails

- Custom Marker accessibility is application-owned. The crosshair must have a focusable semantic element, descriptive label, visible focus style, and arrow-key movement without leaking arrow events to MapLibre camera panning.
- Placement mode must consume the next map click before the existing feature-selection path runs.
- Marker and keyboard listeners must be removed when the anchor is cleared, map unmounts, or the component unmounts.
- No backend/API/schema work is required.
- Existing spot-editor marker behavior, selection, candidates, places, rail, trains, shadows, and persisted location data must remain unchanged.
