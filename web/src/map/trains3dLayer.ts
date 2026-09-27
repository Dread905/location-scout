/**
 * MapLibre custom layer drawing each train as a chain of box carriages laid along its track, sitting on the terrain.
 * Shares the colour program with planes3dLayer; fades in with pitch like the 3D planes.
 */
import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MlMap } from 'maplibre-gl';
import { colourProgram, drawColoured, translated } from './planes3dLayer.js';
import { pitchBlend } from './planes3d.js';
import { boxTriangles, CAR_HEIGHT_M, CAR_LEN_M, CAR_WIDTH_M, placeCarriages } from './trains3d.js';

export interface Train3d {
  lng: number; lat: number; bearing: number | null; live: boolean; carriages: number;
  path?: [number, number][]; pathKm?: number;
}

/** A carriage is drawn at least this long on screen (pixels), so trains stay visible zoomed out. */
const MIN_CAR_PX = 7;
const LIVE: [number, number, number, number] = [0.13, 0.77, 0.37, 1]; // #22c55e, as the flat live marker
const LIVE_NOSE: [number, number, number, number] = [0.94, 0.99, 0.96, 1];
const SCHED: [number, number, number, number] = [0.54, 0.58, 0.65, 0.55]; // #8a93a6, see-through like the hollow ring

export class Trains3dLayer implements CustomLayerInterface {
  id = 'trains-3d';
  type = 'custom' as const;
  renderingMode = '3d' as const;
  private map?: MlMap;
  private prog?: WebGLProgram;
  private buf?: WebGLBuffer;
  private trains: Train3d[] = [];

  setTrains(trains: Train3d[]) { this.trains = trains; if (this.map && pitchBlend(this.map.getPitch()) > 0.001) this.map.triggerRepaint(); }

  onAdd(map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    this.prog = colourProgram(gl);
    this.buf = gl.createBuffer()!;
  }

  onRemove(_map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    if (this.prog) gl.deleteProgram(this.prog);
    if (this.buf) gl.deleteBuffer(this.buf);
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput) {
    const map = this.map;
    if (!map || !this.prog || !this.trains.length) return;
    const alpha = pitchBlend(map.getPitch());
    if (alpha <= 0.001) return;

    const c = map.getCenter();
    const origin = MercatorCoordinate.fromLngLat(c, 0);
    const o: [number, number, number] = [origin.x, origin.y, 0];
    const mpp = (156_543.03 * Math.cos((c.lat * Math.PI) / 180)) / 2 ** map.getZoom();
    const scale = Math.max(1, (MIN_CAR_PX * mpp) / CAR_LEN_M);
    const unit = origin.meterInMercatorCoordinateUnits();
    const terrain = !!map.getTerrain();
    const bounds = map.getBounds();
    const padLng = (bounds.getEast() - bounds.getWest()) * 0.2;
    const padLat = (bounds.getNorth() - bounds.getSouth()) * 0.2;

    const tris: number[] = [];
    for (const t of this.trains) {
      if (t.lng < bounds.getWest() - padLng || t.lng > bounds.getEast() + padLng || t.lat < bounds.getSouth() - padLat || t.lat > bounds.getNorth() + padLat) continue;
      const cars = placeCarriages({ path: t.path, headKm: t.pathKm, head: [t.lng, t.lat], bearing: t.bearing }, t.carriages, scale);
      const base = t.live ? LIVE : SCHED;
      cars.forEach((car, i) => {
        const f = MercatorCoordinate.fromLngLat(car.front, 0);
        const r = MercatorCoordinate.fromLngLat(car.rear, 0);
        const zf = terrain ? (map.queryTerrainElevation(car.front) ?? 0) : 0;
        const zr = terrain ? (map.queryTerrainElevation(car.rear) ?? 0) : 0;
        // Local metres relative to the origin: x east, y north (mercator y grows south).
        const toM = (m: MercatorCoordinate): [number, number] => [(m.x - o[0]) / unit, -(m.y - o[1]) / unit];
        const box = boxTriangles(toM(r), toM(f), CAR_WIDTH_M * scale, CAR_HEIGHT_M * Math.min(scale, 4), zr, zf);
        const col = i === 0 && t.live ? LIVE_NOSE : base;
        for (const { p, shade } of box) {
          // Lead car's roof carries the nose colour; everything else the service colour.
          const cc = i === 0 && t.live && shade !== 1 ? base : col;
          tris.push(p[0] * unit, -p[1] * unit, p[2] * unit, cc[0] * shade, cc[1] * shade, cc[2] * shade, cc[3]);
        }
      });
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST); // on the ground: hills and each other's faces should hide them
    gl.depthFunc(gl.LEQUAL);
    drawColoured(gl, this.prog, this.buf!, translated(args.defaultProjectionData.mainMatrix, o), alpha, [[tris, gl.TRIANGLES]]);
    gl.disable(gl.DEPTH_TEST);
  }
}
