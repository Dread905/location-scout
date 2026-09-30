# PRD — Rolling Routes

## Problem Statement

Location Scout needs saved route planning alongside single spots and places. Routes should render clearly on the map, support ordered sprint/circuit geometry, carry an optional off-route staging point, and integrate with Plan Shoot without changing existing spot workflows.

This polish pass focuses on map readability and operator control after the initial persisted route layer landed.

## Implemented Polish

- Added a first-class **Routes** overlay category to the map legend. It follows the existing persisted legend visibility conventions and can hide/show rendered route layers without mutating saved route records.
- Added a map toolbar **Routes** chip wired to the same overlay state for quick access.
- Reworked persisted route rendering into layered paint: broad glow, dark casing, typed route line, animated dash casing, and animated dash foreground.
- Made route direction animation time-aware. Daylight uses a dark foreground with a light halo; twilight uses warm yellow with a dark halo; night uses a light foreground with a dark halo.
- Added a distinct staging marker when a route has staging coordinates: an “S” badge with its own high-contrast halo, separate from route vertex handles.
- Preserved existing draft editing behavior: the Routes overlay affects rendered route layers, while the editor’s draft handles/source remain available during editing.

## Verification Result

Verified on 2026-09-30:

- `npm test` passed.
- `npm run typecheck` passed.
- `npm run build` passed.

The production build completed with Vite’s existing large chunk warning for the main bundle/map worker assets; no build failure occurred.
