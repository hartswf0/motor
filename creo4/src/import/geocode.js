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

/**
 * A COORDINATE IS A PLACE NAME.
 *
 * Half the time a person already knows exactly where they mean — a survey point,
 * a parcel corner, a pin dropped in another app — and making them invent a
 * searchable name for it is the tool refusing an answer it was handed. This
 * reads the forms people actually have in hand and returns null for anything
 * else, so ordinary searching is untouched.
 *
 *   25.7867, -80.1750           decimal, comma or space
 *   25.7867N 80.1750W           with hemispheres
 *   25°47'12"N 80°10'30"W       degrees, minutes, seconds
 *   .../@25.7867,-80.1750,17z   pasted from a map
 *   geo:25.7867,-80.1750        a shared pin
 */
export function parseCoordinates(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  // a pasted map link carries its coordinates in the middle of the URL
  const at = raw.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/)
    || raw.match(/[?&](?:q|ll|center|mlat)=(-?\d+(?:\.\d+)?)[,%2C]+\s*(-?\d+(?:\.\d+)?)/i)
    || raw.match(/^geo:(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i);
  if (at) return finish(Number(at[1]), Number(at[2]), 'a map link');

  // degrees / minutes / seconds, in either order of hemisphere
  const dms = /(\d+(?:\.\d+)?)\s*[°d:]\s*(?:(\d+(?:\.\d+)?)\s*['′m:]\s*)?(?:(\d+(?:\.\d+)?)\s*["″s]?\s*)?([NSEW])/gi;
  const found = [...raw.matchAll(dms)];
  if (found.length === 2) {
    const val = (m) => {
      const deg = Number(m[1]) + Number(m[2] || 0) / 60 + Number(m[3] || 0) / 3600;
      return /[SW]/i.test(m[4]) ? -deg : deg;
    };
    const a = { v: val(found[0]), ns: /[NS]/i.test(found[0][4]) };
    const b = { v: val(found[1]), ns: /[NS]/i.test(found[1][4]) };
    const lat = a.ns ? a.v : b.v, lon = a.ns ? b.v : a.v;
    return finish(lat, lon, 'degrees, minutes and seconds');
  }

  // plain decimal, with or without hemisphere letters
  const dec = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*°?\s*([NS])?[,;\s]+\s*(-?\d+(?:\.\d+)?)\s*°?\s*([EW])?\s*$/i);
  if (dec) {
    let lat = Number(dec[1]), lon = Number(dec[3]);
    if (dec[2] && /S/i.test(dec[2])) lat = -Math.abs(lat);
    if (dec[4] && /W/i.test(dec[4])) lon = -Math.abs(lon);
    // "80.17, 25.78" with hemispheres the other way round is still meant
    if (dec[2] && /[EW]/i.test(dec[2])) return finish(lon, lat, 'decimal degrees');
    return finish(lat, lon, 'decimal degrees');
  }
  return null;
}

function finish(lat, lon, how) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    lat, lon, how,
    label: `${Math.abs(lat).toFixed(5)}°${lat < 0 ? 'S' : 'N'} ${Math.abs(lon).toFixed(5)}°${lon < 0 ? 'W' : 'E'}`,
  };
}

/** A window around a coordinate, needing no geocoder and no permission. */
export function coordinatePlace(at, metres = 900) {
  const dLat = metres / 2 / 111320;
  const dLon = metres / 2 / (111320 * Math.max(0.05, Math.cos((at.lat * Math.PI) / 180)));
  const bbox = [at.lat - dLat, at.lon - dLon, at.lat + dLat, at.lon + dLon];
  return {
    name: at.label, short: at.label, bbox, lat: at.lat, lon: at.lon,
    kind: 'coordinate/point', importance: 1,
    span: { width: Math.round(metres), height: Math.round(metres) },
    osm: null, windowed: true, coordinate: at,
    why: `${at.label} — read as ${at.how}, ${metres} m around it`,
    alternatives: [],
  };
}

/** What the caller usually wants: a name in, a workable window out. */
export async function resolvePlace(query, { metres = 900, fetchImpl = fetch } = {}) {
  const at = parseCoordinates(query);
  if (at) return coordinatePlace(at, metres);
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
