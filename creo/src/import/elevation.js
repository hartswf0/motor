// REAL GROUND.
//
// OSM has no elevation, and CREO's water model is meaningless without slope.
// This samples a public DEM (opentopodata.org — free, no key, ODbL/USGS terms
// depending on dataset) on a grid across the bounding box.
//
// The sampling resolution is deliberately capped at the DEM's own: ASTER is
// ~30 m, so interpolating a 2 m grid from it would invent detail that is not in
// the data. The place records which dataset it used, so a hydrologist can judge
// the result rather than take it.

const ENDPOINT = 'https://api.opentopodata.org/v1';
const BATCH = 100;           // locations per request, per their API
const GAP_MS = 1100;         // their free tier allows 1 call/second

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {[number,number,number,number]} bbox [south, west, north, east]
 * @returns {{points:Array, spacing:number, dataset:string, attribution:string}}
 */
export async function fetchElevation(bbox, {
  dataset = 'aster30m', maxPoints = 400, fetchImpl = fetch, log = () => {},
} = {}) {
  const [s, w, n, e] = bbox;
  const midLat = (s + n) / 2;
  const mPerDegLat = 111320;
  const mPerDegLon = mPerDegLat * Math.cos((midLat * Math.PI) / 180);
  const heightM = (n - s) * mPerDegLat;
  const widthM = (e - w) * mPerDegLon;

  // Never finer than the DEM itself; never more points than the budget allows.
  const nativeM = dataset.includes('30m') ? 30 : dataset.includes('90m') ? 90 : 10;
  let spacing = Math.max(nativeM, Math.sqrt((widthM * heightM) / maxPoints));
  let nx = Math.max(2, Math.round(widthM / spacing) + 1);
  let ny = Math.max(2, Math.round(heightM / spacing) + 1);
  while (nx * ny > maxPoints) { spacing *= 1.15; nx = Math.max(2, Math.round(widthM / spacing) + 1); ny = Math.max(2, Math.round(heightM / spacing) + 1); }

  const locations = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      locations.push({ lat: s + ((n - s) * j) / (ny - 1), lon: w + ((e - w) * i) / (nx - 1) });
    }
  }

  const points = [];
  for (let k = 0; k < locations.length; k += BATCH) {
    const chunk = locations.slice(k, k + BATCH);
    const q = chunk.map((c) => `${c.lat.toFixed(6)},${c.lon.toFixed(6)}`).join('|');
    log(`elevation ${Math.min(k + BATCH, locations.length)}/${locations.length}…`);
    const res = await fetchImpl(`${ENDPOINT}/${dataset}?locations=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error(`elevation ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const j = await res.json();
    if (j.status !== 'OK') throw new Error(`elevation: ${j.error || j.status}`);
    for (const r of j.results) {
      if (r.elevation === null) continue;
      points.push({ lat: r.location.lat, lon: r.location.lng, elevation: r.elevation });
    }
    if (k + BATCH < locations.length) await sleep(GAP_MS);
  }
  if (points.length < 4) throw new Error('elevation returned too few samples to build terrain');

  const zs = points.map((p) => p.elevation);
  return {
    points,
    spacing: Math.max(4, spacing / 3),       // render grid; interpolation is capped by the sample spacing above
    sampleSpacingM: spacing,
    dataset,
    relief: +(Math.max(...zs) - Math.min(...zs)).toFixed(1),
    datum: Math.min(...zs),
    attribution: `${dataset} via opentopodata.org — sampled every ~${spacing.toFixed(0)} m, relief ${(Math.max(...zs) - Math.min(...zs)).toFixed(1)} m`,
  };
}
