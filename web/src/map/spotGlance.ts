/**
 * Spot glance: cover-photo thumbnails floating above spot dots (a symbol layer whose icons are
 * composited lazily on MapLibre's `styleimagemissing`), and a hover card with the spot at a glance.
 * The string-building parts are pure and tested; the map wiring is at the bottom.
 */
import { Popup, type Map as MlMap, type MapLayerMouseEvent } from 'maplibre-gl';
import type { Spot } from '../api.js';
import { haversineKm } from './geo.js';
import { goodNow, nextGoodWindow, PHASE_LABEL } from './sun.js';
import { hhmm } from '../time.js';

/** Icon id for a thumbnail URL (the prefix keeps them apart from style sprites). */
export const THUMB_PREFIX = 'spot-thumb:';
export const thumbIconId = (url: string | null | undefined) => (url ? THUMB_PREFIX + url : '');
export const THUMB_LAYERS = ['spot-thumbs', 'place-spot-thumbs'];
/** Layers whose hover shows the glance card: the thumbs, and the dots (for spots without photos). */
export const GLANCE_LAYERS = [...THUMB_LAYERS, 'spot-points', 'place-spots'];

/** Icon geometry, in CSS px (drawn at `ICON_RATIO`x). The card's offset and the layer's icon-offset follow from it. */
export const ICON = { size: 40, pad: 3, radius: 7, margin: 6, lift: 8 };
export const ICON_RATIO = 2;
/** Canvas side in CSS px: the square plus room for its shadow. */
export const iconCanvasSide = () => ICON.size + ICON.margin * 2;

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compass(deg: number): string {
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** First `max` characters of the notes on one line, cut at a word with an ellipsis. */
export function excerpt(text: string, max = 110): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–-]+$/, '')}…`;
}

/** "Good now", "Next: Golden PM · today 17:40" (or a weekday), or null when the spot has no good times. */
export function goodStatus(spot: Spot, at: Date): { now: boolean; text: string } | null {
  if (!spot.goodTimes?.phases?.length) return null;
  if (goodNow(spot, at)) return { now: true, text: 'Good now' };
  const w = nextGoodWindow(spot, at);
  if (!w) return { now: false, text: 'No good light in the next 7 days' };
  const sameDay = w.start.toDateString() === at.toDateString();
  const day = sameDay ? 'today' : w.start.toLocaleDateString([], { weekday: 'short' });
  return { now: false, text: `Next: ${PHASE_LABEL[w.phase]} · ${day} ${hhmm(w.start)}` };
}

export interface GlanceCtx { time: Date; home?: { lat: number; lng: number; name?: string } | null }

/** The hover card's HTML. */
export function glanceHtml(spot: Spot, ctx: GlanceCtx): string {
  const parts: string[] = [];
  if (spot.coverThumbUrl) parts.push(`<img class="glance__img" src="${escapeHtml(spot.coverThumbUrl)}" alt="" />`);
  const body: string[] = [`<div class="glance__name">${escapeHtml(spot.name || 'Untitled spot')}</div>`];
  const status = goodStatus(spot, ctx.time);
  if (status) body.push(`<div class="glance__good${status.now ? ' is-now' : ''}">${escapeHtml(status.text)}</div>`);
  const meta: string[] = [];
  if (spot.facingDeg != null) meta.push(`Facing ${compass(spot.facingDeg)} (${Math.round(spot.facingDeg)}°)`);
  if (ctx.home) {
    const km = haversineKm(ctx.home.lat, ctx.home.lng, spot.lat, spot.lng);
    meta.push(`${km < 10 ? km.toFixed(1) : Math.round(km)} km from home`);
  }
  const n = spot.photoCount ?? 0;
  if (n) meta.push(`${n} photo${n === 1 ? '' : 's'}`);
  if (meta.length) body.push(`<div class="glance__meta">${meta.map(escapeHtml).join(' · ')}</div>`);
  if (spot.tags?.length) body.push(`<div class="glance__tags">${spot.tags.slice(0, 6).map((t) => `<span>${escapeHtml(t)}</span>`).join('')}</div>`);
  if (spot.notes?.trim()) body.push(`<div class="glance__notes">${escapeHtml(excerpt(spot.notes))}</div>`);
  parts.push(`<div class="glance__body">${body.join('')}</div>`);
  return parts.join('');
}

/** Popup offset (px) so the card sits above the thumbnail, or just above the dot. */
export function glanceOffset(hasThumb: boolean): number {
  return hasThumb ? ICON.size + ICON.lift + 6 : 12;
}

// --- map wiring ------------------------------------------------------------------------

/** Draw `img` cover-cropped into a rounded white square with a soft shadow. */
function composite(img: CanvasImageSource & { width: number; height: number }): ImageData {
  const r = ICON_RATIO, side = iconCanvasSide() * r, s = ICON.size * r, m = ICON.margin * r, pad = ICON.pad * r;
  const c = document.createElement('canvas');
  c.width = c.height = side;
  const g = c.getContext('2d')!;
  const rr = (x: number, y: number, w: number, rad: number) => { g.beginPath(); g.roundRect(x, y, w, w, rad); };
  g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 5 * r; g.shadowOffsetY = 1.5 * r;
  g.fillStyle = '#ffffff';
  rr(m, m, s, ICON.radius * r); g.fill();
  g.shadowColor = 'transparent';
  const inner = s - pad * 2;
  const k = Math.max(inner / img.width, inner / img.height);
  const sw = inner / k, sh = inner / k;
  g.save(); rr(m + pad, m + pad, inner, (ICON.radius - ICON.pad + 1) * r); g.clip();
  g.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, m + pad, m + pad, inner, inner);
  g.restore();
  return g.getImageData(0, 0, side, side);
}

/** Load thumbnails only when a visible feature asks for them; failed loads keep the blank placeholder. */
export function attachThumbLoader(map: MlMap): () => void {
  const side = iconCanvasSide() * ICON_RATIO;
  const onMissing = (e: { id: string }) => {
    if (!e.id.startsWith(THUMB_PREFIX) || map.hasImage(e.id)) return;
    // A blank placeholder of the final size now, so updateImage can swap in the real one.
    map.addImage(e.id, { width: side, height: side, data: new Uint8Array(side * side * 4) }, { pixelRatio: ICON_RATIO });
    const img = new Image();
    img.onload = () => { try { if (map.hasImage(e.id)) map.updateImage(e.id, composite(img)); } catch { /* map gone */ } };
    img.src = e.id.slice(THUMB_PREFIX.length);
  };
  map.on('styleimagemissing', onMissing);
  return () => { map.off('styleimagemissing', onMissing); };
}

/**
 * Hover card on GLANCE_LAYERS. `getSpot` resolves a feature id; `getCtx` gives map time and home.
 * Returns the controller: `show` (for a touch's first tap), `shownId` and `detach`.
 */
export function attachGlance(map: MlMap, getSpot: (id: string) => Spot | undefined, getCtx: () => GlanceCtx) {
  let popup: Popup | null = null;
  let shownId: string | null = null;
  const hide = () => { popup?.remove(); popup = null; shownId = null; };
  const show = (id: string, at: [number, number]) => {
    const spot = getSpot(id);
    if (!spot) return hide();
    if (shownId === id && popup) return;
    popup?.remove();
    popup = new Popup({ closeButton: false, closeOnClick: false, anchor: 'bottom', offset: glanceOffset(!!spot.coverThumbUrl), className: 'glance', maxWidth: '260px' })
      .setLngLat(at).setHTML(glanceHtml(spot, getCtx())).addTo(map);
    shownId = id;
  };
  const move = (e: MapLayerMouseEvent) => {
    const f = e.features?.[0];
    const id = f?.properties?.id as string | undefined;
    if (id) show(id, (f!.geometry as GeoJSON.Point).coordinates as [number, number]);
  };
  // Moving from a thumb onto its own dot fires leave then move, which simply re-shows the card.
  const leave = () => hide();
  const bound = GLANCE_LAYERS;
  for (const l of bound) { map.on('mousemove', l, move); map.on('mouseleave', l, leave); }
  map.on('movestart', hide);
  return {
    show, hide,
    get shownId() { return shownId; },
    detach() {
      for (const l of bound) { map.off('mousemove', l, move); map.off('mouseleave', l, leave); }
      map.off('movestart', hide);
      hide();
    },
  };
}
