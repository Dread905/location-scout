/** GPX export, built by hand as a string — no XML library for one tag shape. */

export interface GpxWaypoint {
  lat: number;
  lng: number;
  name: string;
  desc?: string;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildGpx(waypoints: GpxWaypoint[]): string {
  const wpts = waypoints
    .map(
      (w) => `  <wpt lat="${w.lat}" lon="${w.lng}">
    <name>${xmlEscape(w.name)}</name>${w.desc ? `\n    <desc>${xmlEscape(w.desc)}</desc>` : ''}
  </wpt>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="location-scout" xmlns="http://www.topografix.com/GPX/1/1">
${wpts}
</gpx>
`;
}
