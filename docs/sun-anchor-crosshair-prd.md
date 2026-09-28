# PRD — Draggable Sun-Anchor Crosshair

## Problem Statement

Location Scout’s sun rays and TimeBar use a selected spot or, when no spot is selected, the map viewport centre. A photographer cannot place an independent planning reference at an arbitrary point on the map and keep it there while moving the camera, comparing features, or changing selection.

The map needs a clear, temporary way to anchor the sun display to any chosen location without creating or editing a saved spot.

## Solution

Add a user-controlled **sun-anchor crosshair** to the map.

A map tool puts the user into sun-anchor placement mode. The next map click creates a visible draggable crosshair at that coordinate. While the anchor exists, the solar rays and TimeBar use it as their location reference rather than following the viewport camera. Dragging the crosshair updates the display live. A clear/follow-camera control removes the anchor and restores the existing fallback behavior.

## User Stories

1. As a photographer, I want to place a sun crosshair anywhere on the map, so I can plan sunlight at a precise location without saving a spot first.
2. As a photographer, I want the sun, moon, sunrise, and sunset rays to originate at the crosshair, so the map clearly shows the relevant directions from my planned position.
3. As a photographer, I want the TimeBar’s solar phase, azimuth, altitude, and day gradient to use the crosshair position, so the numerical display matches the rays.
4. As a photographer, I want to drag the crosshair, so I can refine the planning point without repeating placement.
5. As a photographer, I want the display to update while I drag, so I can immediately compare nearby terrain or composition options.
6. As a photographer, I want the anchor to remain fixed while I pan, zoom, pitch, or rotate the map, so it does not follow the camera.
7. As a photographer, I want a clear way to remove the anchor and return to follow-camera mode, so I can return to the current workflow deliberately.
8. As a photographer, I want placement mode to affect only my next map click, so ordinary clicks continue selecting spots, places, candidates, and trains.
9. As a photographer, I want a selected saved spot or an edited spot to continue driving the display when no sun anchor exists, so current spot-planning behavior is preserved.
10. As a photographer, I want the anchor to override a selected spot while it exists, so the explicit planning point always wins.
11. As a keyboard user, I want the crosshair to be focusable, described, and movable by keyboard, so the feature does not require a mouse.
12. As a photographer, I do not want placing or moving a sun anchor to create a saved spot, modify a place, or write data to the server.
13. As a photographer, I want terrain and building shadows to remain tied to the visible viewport, so the visual shadow overlay still reflects the terrain and buildings on screen.
14. As a developer, I want the sun-origin priority to be pure and tested, so selection, editing, and anchor behavior remain predictable as the map evolves.
15. As a contributor, I want marker/map listener cleanup tested or manually verified, so changing pages or clearing an anchor never leaves orphaned UI or event handlers.

## Implementation Decisions

- Add an in-memory nullable sun-anchor coordinate to the map page. It is not persisted to the database, browser storage, settings, URLs, share links, imports, or exports.
- Add an explicit map-tool control for sun-anchor placement and a separate clear/follow-camera action when an anchor exists.
- Placement mode consumes the next map click, sets the anchor, exits placement mode, and prevents that click from entering the existing selection path.
- Render the anchor as one custom MapLibre draggable Marker with a crosshair/target visual treatment. Reuse the existing SpotEditor marker lifecycle pattern: create when the map and anchor are available, sync location from state, subscribe to drag events, and remove marker/listeners on clear and unmount.
- The marker’s DOM element must be application-accessible: semantic focus target, accessible name, clear drag instructions, visible focus treatment, and keyboard movement. Arrow-key movement must use MapLibre project/unproject movement (one screen pixel per press; ten with Shift) and stop propagation so it does not pan the map at the same time.
- Define a pure display-origin resolver. Its precedence is: sun anchor, then editing spot draft, then selected saved spot, then viewport centre. Candidates and places do not implicitly become display origins in this slice.
- Use the resolved display origin for `updateRays()` and `TimeBar` only. Keep viewport hillshade/mood/3D light and building/terrain shadows tied to viewport centre, avoiding a planning pin changing rendering of unrelated visible terrain.
- Existing time-slider behavior and ray length scaling remain unchanged.
- Changing, clearing, or dragging the anchor must not modify spot/place/candidate data, selection state, or map camera position.

## Testing Decisions

- Strict TDD is required for every production behavior: add a focused failing test, run it and observe RED, add the minimal implementation, then run the relevant test file and full workspace verification.
- Add pure tests for the display-origin resolver: anchor wins over draft/selected/centre; draft wins over selected/centre when no anchor exists; selected wins over centre when no anchor/draft exists; centre is the final fallback.
- Add pure tests for keyboard nudge behavior: each arrow direction changes only the expected coordinate by the defined increment; invalid/non-arrow input does not move the anchor.
- Add tests for the existing solar functions only if a new pure helper is introduced; do not duplicate SunCalc math tests unnecessarily.
- Add focused UI/controller tests at the highest practical seam for placement mode and marker lifecycle. If the current test environment cannot instantiate MapLibre Marker, isolate creation/subscription/cleanup behind a small injectable adapter and test behavior through that adapter rather than calling a live map.
- Verify manually in the local map: place crosshair on empty map, drag it, pan camera away, select/deselect a saved spot, clear anchor, test keyboard nudge, and confirm no spot/place/candidate records are created or changed.
- Run `npm run typecheck && npm test`. No automated test may rely on a live map tile service or external solar service.

## Out of Scope

- Persisting a sun anchor across reloads, devices, user accounts, URLs, exports, or shared links.
- Creating saved spots, candidates, places, or database records from an anchor.
- Auto-anchoring to a clicked candidate or selected place.
- Reworking current spot selection or editing interactions.
- Changing shadow geometry, terrain shadows, hillshade, imagery mood, 3D building lighting, map camera behavior, or solar astronomy calculations.
- Multiple simultaneous anchors, routes, anchor history, or an anchor library.

## Further Notes

- Research and source trail: `docs/sun-anchor-crosshair-research.md`.
- Existing map behavior and reusable Marker lifecycle were inspected in MapPage, layers, sun maths, TimeBar, SpotEditor, and the map stylesheet.
- Branch: `scott/sun-anchor-crosshair`.
- The required user-facing language is “sun anchor” or “sun crosshair”; avoid calling it a saved spot.
