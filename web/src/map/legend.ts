/** Legend categories: groups base-style and overlay layers by id / source-layer / filter, with swatches. */

/** Minimal layer shape (a MapLibre LayerSpecification fits). */
export interface LegendLayer {
  id: string;
  type: string;
  source?: unknown;
  'source-layer'?: string;
  filter?: unknown;
  paint?: Record<string, unknown>;
}

export type SwatchKind = 'line' | 'dashed' | 'fill' | 'dot' | 'text' | 'ring';
export interface Category {
  key: string;
  label: string;
  group: 'Base map' | 'Overlays';
  swatch: SwatchKind;
  /** Fallback colour when the style paint isn't a plain colour. */
  color: string;
  /** Paint property to read the colour from (on the first matching layer that has a literal). */
  paintProp?: string;
  defaultOn: boolean;
  match: (l: LegendLayer) => boolean;
}

const sl = (l: LegendLayer) => l['source-layer'];
const f = (l: LegendLayer) => JSON.stringify(l.filter ?? null);
const isRail = (l: LegendLayer) => /\brail\b|"transit"|_rail/.test(`${l.id} ${f(l)}`);
const isPath = (l: LegendLayer) => /path|pedestrian|service_track|"track"/.test(`${l.id} ${f(l)}`);
const ids = (...list: string[]) => (l: LegendLayer) => list.includes(l.id);

export const CATEGORIES: Category[] = [
  { key: 'roads', label: 'Roads', group: 'Base map', swatch: 'line', color: '#fc8', paintProp: 'line-color', defaultOn: true,
    match: (l) => (sl(l) === 'transportation' && !isRail(l) && !isPath(l)) || sl(l) === 'aeroway' },
  { key: 'rail-base', label: 'Railways', group: 'Base map', swatch: 'dashed', color: '#bbb', paintProp: 'line-color', defaultOn: true,
    match: (l) => sl(l) === 'transportation' && isRail(l) },
  { key: 'paths', label: 'Paths & tracks', group: 'Base map', swatch: 'dashed', color: '#cba', paintProp: 'line-color', defaultOn: true,
    match: (l) => sl(l) === 'transportation' && isPath(l) && !isRail(l) },
  { key: 'water', label: 'Water', group: 'Base map', swatch: 'fill', color: '#9ec7e8', paintProp: 'fill-color', defaultOn: true,
    match: (l) => (sl(l) === 'water' || sl(l) === 'waterway') && l.type !== 'symbol' },
  { key: 'buildings', label: 'Buildings', group: 'Base map', swatch: 'fill', color: '#d9d0c9', paintProp: 'fill-color', defaultOn: true,
    match: (l) => sl(l) === 'building' },
  { key: 'boundaries', label: 'Boundaries', group: 'Base map', swatch: 'dashed', color: '#a37da1', paintProp: 'line-color', defaultOn: true,
    match: (l) => sl(l) === 'boundary' },
  { key: 'landuse', label: 'Land use & parks', group: 'Base map', swatch: 'fill', color: '#d8e8c8', paintProp: 'fill-color', defaultOn: true,
    match: (l) => ['park', 'landuse', 'landcover'].includes(sl(l) ?? '') },
  { key: 'labels', label: 'Place & road labels', group: 'Base map', swatch: 'text', color: '#333', paintProp: 'text-color', defaultOn: true,
    match: (l) => l.type === 'symbol' && ['place', 'transportation_name', 'water_name', 'waterway', 'aerodrome_label', 'transportation'].includes(sl(l) ?? '') },
  { key: 'pois', label: 'Points of interest', group: 'Base map', swatch: 'dot', color: '#666', paintProp: 'text-color', defaultOn: true,
    match: (l) => sl(l) === 'poi' },

  { key: 'imagery', label: 'Satellite imagery', group: 'Overlays', swatch: 'fill', color: '#3b5a3a', defaultOn: false, match: ids('imagery') },
  { key: 'terrain', label: 'Terrain shading', group: 'Overlays', swatch: 'fill', color: '#5a5f6e', defaultOn: true, match: ids('hillshade', 'terrain-shadow') },
  { key: 'shadows', label: 'Building shadows', group: 'Overlays', swatch: 'fill', color: '#0a0c1a', paintProp: 'fill-color', defaultOn: true, match: ids('shadows') },
  { key: 'outlines', label: 'Place outlines', group: 'Overlays', swatch: 'line', color: '#f5a623', paintProp: 'line-color', defaultOn: true, match: ids('place-fill', 'place-line') },
  { key: 'sun', label: 'Sun/moon rays & light wedges', group: 'Overlays', swatch: 'line', color: '#ffd23f', defaultOn: true, match: ids('rays', 'wedges') },
  { key: 'rail', label: 'Rail network', group: 'Overlays', swatch: 'line', color: '#4cc3ff', defaultOn: false, match: ids('rail-lines', 'rail-industrial') },
  { key: 'trains', label: 'Trains', group: 'Overlays', swatch: 'ring', color: '#22c55e', defaultOn: false, match: ids('trains') },
  { key: 'planes', label: 'Planes', group: 'Overlays', swatch: 'dashed', color: '#dfe7ff', defaultOn: false, match: ids('planes', 'planes-proj', 'planes-ghost', 'planes-shadow', 'planes-label', 'planes-3d') },
  { key: 'candidates', label: 'OSM candidates', group: 'Overlays', swatch: 'dot', color: '#6b7280', defaultOn: false, match: ids('candidates') },
];

export function categoryOf(layer: LegendLayer): string | null {
  return CATEGORIES.find((c) => c.match(layer))?.key ?? null;
}

/** Layer ids per category key, in style order. */
export function groupLayers(layers: LegendLayer[]): Record<string, string[]> {
  const out: Record<string, string[]> = Object.fromEntries(CATEGORIES.map((c) => [c.key, [] as string[]]));
  for (const l of layers) {
    const k = categoryOf(l);
    if (k) out[k].push(l.id);
  }
  return out;
}

/** Swatch colour: the first plain-string paint value among the category's layers, else the fallback. */
export function swatchColor(cat: Category, layers: LegendLayer[]): string {
  if (cat.paintProp) {
    for (const l of layers) {
      if (!cat.match(l)) continue;
      const v = l.paint?.[cat.paintProp];
      if (typeof v === 'string') return v;
    }
  }
  return cat.color;
}

export type Visibility = Record<string, boolean>;
const KEY = 'ls.legend';
export function defaultVisibility(): Visibility {
  return Object.fromEntries(CATEGORIES.map((c) => [c.key, c.defaultOn]));
}
export function loadVisibility(): Visibility {
  const v = defaultVisibility();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    for (const k of Object.keys(v)) if (typeof saved[k] === 'boolean') v[k] = saved[k];
  } catch { /* no storage */ }
  return v;
}
export function saveVisibility(v: Visibility) {
  try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* no storage */ }
}
