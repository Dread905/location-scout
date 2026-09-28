// Export one Atlas Photo city page (public schema.org data) as a GeoJSON bundle
// for POST /api/import. Posts of the same place are merged into one spot.
// Usage: node scripts/atlas-export.mjs australia/new-south-wales/bathurst [more cities...] > data/bathurst.geojson
const cities = process.argv.slice(2);
if (!cities.length) throw new Error('usage: atlas-export.mjs <country/region/city>...');

const ld = async (url) => {
  const html = await (await fetch(url)).text();
  return [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)]
    .map((m) => JSON.parse(m[1])).flat();
};

const posts = [];
const list = [];
for (const city of cities) {
  list.push(...(await ld(`https://atlasphoto.app/photo-spots/${city}`)).find((x) => x['@type'] === 'ItemList').itemListElement);
}
for (const it of list) {
  const d = await ld(it.url);
  const a = d.find((x) => x['@type'] === 'TouristAttraction') ?? {};
  const img = d.find((x) => x['@type'] === 'ImageObject') ?? {};
  if (a.geo?.latitude == null) continue;
  posts.push({
    name: a.name ?? it.name,
    description: a.description ?? '',
    lat: a.geo.latitude,
    lng: a.geo.longitude,
    photographer: img.creator?.name ?? null,
    url: it.url,
  });
  await new Promise((r) => setTimeout(r, 400)); // be polite
}

// Same place = same name once "circuit"/"motor racing"/punctuation are dropped, within 1 km.
const key = (n) => n.toLowerCase().replace(/motor racing|circuit|[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const km = (a, b) => Math.hypot(a.lat - b.lat, (a.lng - b.lng) * Math.cos((a.lat * Math.PI) / 180)) * 111;
const groups = [];
for (const p of posts) {
  const g = groups.find((g) => key(g[0].name) === key(p.name) && km(g[0], p) < 1);
  g ? g.push(p) : groups.push([p]);
}

const features = groups.map((g) => {
  const lat = g.reduce((s, p) => s + p.lat, 0) / g.length;
  const lng = g.reduce((s, p) => s + p.lng, 0) / g.length;
  const notes = g
    .map((p) => `${p.description}\n— ${p.photographer ? `@${p.photographer}, ` : ''}${p.url}`)
    .join('\n\n');
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [+lng.toFixed(5), +lat.toFixed(5)] },
    properties: {
      kind: 'spot',
      id: g[0].url,
      name: g.reduce((a, p) => (p.name.length < a.length ? p.name : a), g[0].name), // shortest name
      notes,
      tags: ['atlasphoto'],
      source: 'atlasphoto',
      sourceRef: g[0].url.split('/').pop(), // re-import updates instead of duplicating
    },
  };
});

console.error(`${posts.length} posts -> ${features.length} spots`);
console.log(JSON.stringify({ type: 'FeatureCollection', features }, null, 2));
