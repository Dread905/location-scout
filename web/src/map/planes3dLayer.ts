/**
 * MapLibre custom layer drawing each plane at its real height as a small low-poly marker oriented by track,
 * with a thin vertical line down to the ground. Plain WebGL (no three.js: one shader, two draw calls).
 */
import { MercatorCoordinate, type CustomLayerInterface, type CustomRenderMethodInput, type Map as MlMap } from 'maplibre-gl';
import { PLANE_MESH, pitchBlend, renderAltitude, rotateByTrack } from './planes3d.js';

export interface Plane3d { lng: number; lat: number; altM: number; track: number }

const VS = `
attribute vec3 a_pos; attribute vec4 a_color;
uniform mat4 u_matrix; varying vec4 v_color;
void main() { gl_Position = u_matrix * vec4(a_pos, 1.0); v_color = a_color; }`;
const FS = `
precision mediump float; varying vec4 v_color; uniform float u_alpha;
void main() { gl_FragColor = vec4(v_color.rgb, v_color.a * u_alpha); }`;

/** Marker wingspan on screen, pixels (converted to metres at the current zoom), with a real-world floor. */
const SPAN_PX = 26;
const MIN_SPAN_M = 60;
const BODY: [number, number, number, number] = [0.62, 0.7, 0.95, 1];
const FIN: [number, number, number, number] = [0.4, 0.46, 0.66, 1];
const LINE: [number, number, number, number] = [0.87, 0.9, 1, 0.55];

/** m * translate(o): lets the vertices be small offsets from `o`, so float32 keeps precision at high zoom. */
function translated(m: ArrayLike<number>, o: [number, number, number]): Float32Array {
  const r = new Float32Array(16);
  for (let i = 0; i < 12; i++) r[i] = m[i];
  for (let row = 0; row < 4; row++) r[12 + row] = m[row] * o[0] + m[4 + row] * o[1] + m[8 + row] * o[2] + m[12 + row];
  return r;
}

export class Planes3dLayer implements CustomLayerInterface {
  id = 'planes-3d';
  type = 'custom' as const;
  renderingMode = '3d' as const;
  private map?: MlMap;
  private prog?: WebGLProgram;
  private buf?: WebGLBuffer;
  private planes: Plane3d[] = [];

  setPlanes(planes: Plane3d[]) { this.planes = planes; this.map?.triggerRepaint(); }

  onAdd(map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    const sh = (type: number, s: string) => { const x = gl.createShader(type)!; gl.shaderSource(x, s); gl.compileShader(x); return x; };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    this.prog = p;
    this.buf = gl.createBuffer()!;
  }

  onRemove(_map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    if (this.prog) gl.deleteProgram(this.prog);
    if (this.buf) gl.deleteBuffer(this.buf);
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput) {
    const map = this.map;
    if (!map || !this.prog || !this.planes.length) return;
    const alpha = pitchBlend(map.getPitch());
    if (alpha <= 0.001) return;

    const c = map.getCenter();
    const origin = MercatorCoordinate.fromLngLat(c, 0);
    const o: [number, number, number] = [origin.x, origin.y, 0];
    const mpp = (156_543.03 * Math.cos((c.lat * Math.PI) / 180)) / 2 ** map.getZoom();
    const spanM = Math.max(MIN_SPAN_M, SPAN_PX * mpp);
    const exag = map.getTerrain()?.exaggeration ?? 1;

    const tris: number[] = [];
    const lines: number[] = [];
    const push = (arr: number[], x: number, y: number, z: number, col: number[]) => arr.push(x - o[0], y - o[1], z, ...col);
    for (const pl of this.planes) {
      const ground = map.getTerrain() ? (map.queryTerrainElevation([pl.lng, pl.lat]) ?? 0) : 0;
      const z = renderAltitude(pl.altM, ground, exag);
      const mc = MercatorCoordinate.fromLngLat([pl.lng, pl.lat], z);
      const g = MercatorCoordinate.fromLngLat([pl.lng, pl.lat], ground);
      const s = (spanM / 2) * mc.meterInMercatorCoordinateUnits();
      PLANE_MESH.forEach(([x, y, zz], i) => {
        const [rx, ry] = rotateByTrack(x, y, pl.track);
        push(tris, mc.x + rx * s, mc.y - ry * s, mc.z + zz * s, i >= 12 ? FIN : BODY);
      });
      push(lines, mc.x, mc.y, mc.z, LINE);
      push(lines, g.x, g.y, g.z, LINE);
    }

    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'u_matrix'), false, translated(args.defaultProjectionData.mainMatrix, o));
    gl.uniform1f(gl.getUniformLocation(this.prog, 'u_alpha'), alpha);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf!);
    const aPos = gl.getAttribLocation(this.prog, 'a_pos');
    const aCol = gl.getAttribLocation(this.prog, 'a_color');
    gl.enableVertexAttribArray(aPos);
    gl.enableVertexAttribArray(aCol);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST); // always drawn over terrain: planes are in the sky, and the depth range is MapLibre's
    for (const [data, mode] of [[lines, gl.LINES], [tris, gl.TRIANGLES]] as const) {
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 28, 0);
      gl.vertexAttribPointer(aCol, 4, gl.FLOAT, false, 28, 12);
      gl.drawArrays(mode, 0, data.length / 7);
    }
  }
}
