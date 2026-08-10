// ANY LOCATION, BY NAME.
//
// Nominatim is OpenStreetMap's own geocoder: free, no key, and run on donated
// hardware — so it asks for a real user agent and no more than one request a
// second, and this module keeps both promises.
//
// A name is often ambiguous ("Springfield"), and a named area is often the wrong
// size to inhabit (a whole city is not a place you can stand in). Both are
// handled explicitly rather than by picking the first result and hoping.

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const UA = 'CREO/0.1 (place import; github.com/hartswf0/motor)';
const MIN_GAP_MS = 1100;
let lastCall = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function polite(url, fetchImpl) {
  const wait = MIN_GAP_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const res = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) throw new Error(`geocoder ${res.status}`);
  return res.json();
}

/** Metres across, for a [south, west, north, east] box. */
export function bboxMetres(bbox) {
  const [s, w, n, e] = bbox;
  const mid = ((s + n) / 2) * (Math.PI / 180);
  return {
    height: (n - s) * 111320,
    width: (e - w) * 111320 * Math.cos(mid),
  };
}

/**
 * A window you can actually inhabit, centred on the result. A suburb's own
 * bounding box may be 8 km across; a building's may be 40 m. Both become a
 * walkable extent, and the original is kept so the caller can say what it did.
 */
export function windowAround(bbox, metres = 900) {
  const [s, w, n, e] = bbox;
  const lat = (s + n) / 2, lon = (w + e) / 2;
  const dLat = metres / 2 / 111320;
  const dLon = metres / 2 / (111320 * Math.cos((lat * Math.PI) / 180));
  return [lat - dLat, lon - dLon, lat + dLat, lon + dLon];
}

/**
 * @returns {Promise<Array<{name, short, bbox, lat, lon, kind, importance, span}>>}
 *          candidates, best first — the caller chooses, nothing is assumed.
 */
export async function geocode(query, { limit = 5, fetchImpl = fetch } = {}) {
  const url = `${NOMINATIM}/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=${limit}&addressdetails=1&polygon_geojson=0`;
  const results = await polite(url, fetchImpl);
  return results.map((r) => {
    const bb = r.boundingbox.map(Number);              // [south, north, west, east]
    const bbox = [bb[0], bb[2], bb[1], bb[3]];         // → [south, west, north, east]
    const span = bboxMetres(bbox);
    const a = r.address || {};
    return {
      name: r.display_name,
      short: [a.neighbourhood || a.suburb || a.village || a.town || a.city_district || r.name,
              a.city || a.county, a.country].filter(Boolean).join(', ') || r.display_name,
      bbox, lat: Number(r.lat), lon: Number(r.lon),
      kind: `${r.category}/${r.type}`,
      importance: r.importance,
      span: { width: Math.round(span.width), height: Math.round(span.height) },
      osm: r.osm_type && r.osm_id ? `${r.osm_type}/${r.osm_id}` : null,
    };
  });
}

/** What the caller usually wants: a name in, a workable window out. */
export async function resolvePlace(query, { metres = 900, fetchImpl = fetch } = {}) {
  const hits = await geocode(query, { fetchImpl });
  if (!hits.length) throw new Error(`nothing found for “${query}”`);
  const best = hits[0];
  const tooBig = best.span.width > metres * 1.6 || best.span.height > metres * 1.6;
  const tooSmall = best.span.width < metres * 0.25 && best.span.height < metres * 0.25;
  return {
    ...best,
    bbox: tooBig || tooSmall ? windowAround(best.bbox, metres) : best.bbox,
    windowed: tooBig || tooSmall,
    why: tooBig ? `${best.short} is ${best.span.width}×${best.span.height} m — larger than one place; taking a ${metres} m window at its centre`
       : tooSmall ? `${best.short} is only ${best.span.width}×${best.span.height} m — taking a ${metres} m window around it`
       : null,
    alternatives: hits.slice(1),
  };
}
