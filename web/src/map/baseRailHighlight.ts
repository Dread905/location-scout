import { groupLayers, type LegendLayer } from './legend.js';

const RAIL_BASE = 'rail-base';
const HIGHLIGHT = {
  'line-color': '#f5a623',
  'line-width': 4,
  'line-opacity': 0.95,
} as const;

type PaintProp = keyof typeof HIGHLIGHT;
const PAINT_PROPS = Object.keys(HIGHLIGHT) as PaintProp[];

export interface BaseRailMap {
  getStyle(): { layers?: LegendLayer[] };
  getLayer(id: string): { id: string; type?: string } | undefined;
  getPaintProperty(id: string, prop: string): unknown;
  setPaintProperty(id: string, prop: string, value: unknown): unknown;
}

export type BaseRailPaintSnapshot = {
  id: string;
  paint: Partial<Record<PaintProp, unknown>>;
  highlighted: Partial<Record<PaintProp, unknown>>;
};

export function effectiveRailOn(railOn: boolean, trainsOn: boolean) {
  return railOn || trainsOn;
}

export function baseRailLayerIds(layers: LegendLayer[]) {
  return (groupLayers(layers)[RAIL_BASE] ?? []).filter((id) => layers.find((l) => l.id === id)?.type === 'line');
}

export function applyBaseRailHighlight(map: BaseRailMap): BaseRailPaintSnapshot[] {
  const ids = baseRailLayerIds(map.getStyle().layers ?? []);
  const snapshot: BaseRailPaintSnapshot[] = [];
  for (const id of ids) {
    if (map.getLayer(id)?.type !== 'line') continue;
    const paint: BaseRailPaintSnapshot['paint'] = {};
    const highlighted: BaseRailPaintSnapshot['highlighted'] = {};
    for (const prop of PAINT_PROPS) {
      paint[prop] = map.getPaintProperty(id, prop);
      highlighted[prop] = HIGHLIGHT[prop];
      if (!samePaint(paint[prop], highlighted[prop])) map.setPaintProperty(id, prop, highlighted[prop]);
    }
    snapshot.push({ id, paint, highlighted });
  }
  return snapshot;
}

export function restoreBaseRailHighlight(map: BaseRailMap, snapshot: BaseRailPaintSnapshot[]) {
  for (const layer of snapshot) {
    if (!map.getLayer(layer.id)) continue;
    for (const prop of PAINT_PROPS) {
      if (!samePaint(map.getPaintProperty(layer.id, prop), layer.highlighted[prop])) continue;
      map.setPaintProperty(layer.id, prop, layer.paint[prop]);
    }
  }
}

function samePaint(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
