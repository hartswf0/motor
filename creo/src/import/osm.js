// REAL PLACES.
//
// Until now every place in CREO was a procedural fiction anchored to a real
// latitude that it had no relationship to. This module removes that gap: it
// reads OpenStreetMap — free, no API key, ODbL — and turns actual buildings,
// roads, paths, waterways and land use into ordinary PlaceModel entities.
//
// Every imported entity keeps its OSM identity, so "why are you here?" answers
// with a citation a surveyor can follow: way/123456789, its tags, and the date
// it was fetched. Imported data is IMPORTED, never CONFIRMED — §18 holds. A
// resident saying a lane has not been passable for years still outranks nothing,
// and still coexists with it.
//
// Data © OpenStreetMap contributors, ODbL. Elevation from AWS terrarium tiles.

import * as G from '../core/geom.js';
import { Place, Heightfield, makeEntity } from '../core/place.js';
import { World } from '../core/world.js';

/** The bounding box in local metres — the frame terrain and entities share. */
export function localBounds(projection, bbox) {
  const a = projection.toLocal(bbox[0], bbox[1]);
  const b = projection.toLocal(bbox[2], bbox[3]);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/** bbox is [south, west, north, east] in degrees. */
export function overpassQuery(bbox) {
  const b = bbox.join(',');
  return `[out:json][timeout:90];
(
  way["building"](${b});
  relation["building"](${b});
  way["highway"](${b});
  way["waterway"](${b});
  way["natural"~"water|wood|scrub|wetland"](${b});
  way["landuse"](${b});
  way["barrier"~"wall|fence|retaining_wall"](${b});
  way["railway"](${b});
  way["leisure"](${b});
  node["natural"="tree"](${b});
  node["amenity"](${b});
  node["shop"](${b});
  node["tourism"](${b});
  node["highway"="bus_stop"](${b});
  node["place"](${b});
);
out geom tags;`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Overpass is a free service running on donated hardware with a slot system.
 * 429 means "wait your turn" and 504 means "I am busy", and both are normal —
 * a client that hammers through them is the reason the service needs limits.
 */
export async function fetchOSM(bbox, { mirrors = MIRRORS, fetchImpl = fetch, rounds = 4, log = () => {} } = {}) {
  let lastError = null;
  for (let round = 0; round < rounds; round++) {
    for (const url of mirrors) {
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'user-agent': 'CREO/0.1 (place import; github.com/hartswf0/motor)',
          },
          body: new URLSearchParams({ data: overpassQuery(bbox) }),
        });
        if (res.status === 429 || res.status === 504 || res.status === 503) {
          lastError = new Error(`${new URL(url).host} → ${res.status}`);
          log(`${new URL(url).host} is busy (${res.status})`);
          continue;
        }
        if (!res.ok) { lastError = new Error(`${new URL(url).host} → ${res.status}`); continue; }
        const json = await res.json();
        if (!json.elements) { lastError = new Error(`${new URL(url).host} → no elements`); continue; }
        return { json, mirror: url };
      } catch (err) { lastError = err; log(`${new URL(url).host}: ${err.message.slice(0, 60)}`); }
    }
    if (round < rounds - 1) {
      const wait = 8000 * (round + 1);
      log(`all mirrors busy; waiting ${wait / 1000}s before retrying`);
      await sleep(wait);
    }
  }
  throw new Error(`every Overpass mirror failed after ${rounds} rounds: ${lastError?.message || 'unknown'}`);
}

// ------------------------------------------------------------- conversion ---
const ROAD_WIDTH = {
  motorway: 14, trunk: 12, primary: 10, secondary: 8.5, tertiary: 7,
  unclassified: 5.5, residential: 5.5, service: 4, living_street: 5,
  pedestrian: 4, footway: 1.8, path: 1.4, track: 3.2, cycleway: 2, steps: 1.6,
};
const PATH_KINDS = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'track']);

/** Storeys → metres, using OSM's own tags before guessing. */
function buildingHeight(tags) {
  const h = parseFloat(tags['height'] || tags['building:height']);
  if (Number.isFinite(h) && h > 0) return { height: h, basis: 'height tag' };
  const levels = parseFloat(tags['building:levels'] || tags['levels']);
  if (Number.isFinite(levels) && levels > 0) return { height: levels * 3.1, basis: `${levels} levels × 3.1 m` };
  const kind = tags['building'];
  const guess = { house: 4, residential: 6, apartments: 12, hut: 2.6, shed: 2.6, garage: 2.6, industrial: 8, warehouse: 8, commercial: 7, retail: 6, school: 7, church: 9, roof: 3 }[kind];
  return { height: guess ?? 5, basis: 'assumed from building type — no height in OSM' };
}

/**
 * @returns {World} a real place, with a real projection and real provenance.
 */
export function osmToPlace(osm, { key, name, bbox, terrain = null, fetchedAt = null, mirror = null }) {
  const anchor = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  const place = new Place({ id: key, name, anchor, seed: 1 });
  place.meta = {
    source: 'OpenStreetMap',
    licence: 'ODbL — © OpenStreetMap contributors',
    bbox, fetchedAt, mirror,
    elevation: terrain ? terrain.attribution : 'none — treated as flat',
    relief: terrain ? terrain.relief : 0,
    datum: terrain ? terrain.datum : null,
  };
  const P = place.projection;
  const toLocal = (n) => P.toLocal(n.lat, n.lon);

  // Terrain first: everything else sits on it.
  const bounds = localBounds(P, bbox);
  // A small margin so a building on the edge is not sliced off, but not so much
  // that the place sprawls past the ground beneath it.
  const pad = 0.06 * Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]);
  const window_ = [bounds[0] - pad, bounds[1] - pad, bounds[2] + pad, bounds[3] + pad];
  place.terrain = terrain ? terrain.heightfield : new Heightfield(bounds, 10);

  const world = new World(place);
  const stats = { buildings: 0, roads: 0, paths: 0, water: 0, surfaces: 0, trees: 0, walls: 0, skipped: 0 };

  const add = (spec, el) => {
    // Pull the id out first: spreading a spec whose id is undefined used to
    // erase the OSM id, and every entity then landed under the same key.
    const { id: specId, ...rest } = spec;
    const e = makeEntity({
      id: specId || `osm_${el.type[0]}${el.id}`,
      source: 'OpenStreetMap',
      epistemic: 'IMPORTED',
      author: 'OpenStreetMap contributors',
      evidence: [{ kind: 'osm', ref: `${el.type}/${el.id}`, tags: el.tags || {}, fetchedAt }],
      props: { osm: { type: el.type, id: el.id, tags: el.tags || {} } },
      ...rest,
    });
    place.put(e, 'AS_IS');
    return e;
  };

  for (const el of osm.elements) {
    const tags = el.tags || {};

    if (el.type === 'node') {
      // Everything OSM names at a point: shops, stops, clinics, kiosks, wells.
      // These were being fetched and discarded, which is why the world felt
      // emptier than the place it came from.
      const poiKind = tags.amenity || tags.shop || tags.tourism || (tags.highway === 'bus_stop' ? 'bus stop' : null) || tags.place;
      if (poiKind && tags.natural !== 'tree') {
        const [x, y] = toLocal(el);
        if (!inWindow([x, y], window_)) { stats.skipped++; continue; }
        const z = place.groundAt(x, y);
        add({
          type: 'marker', subtype: String(poiKind),
          name: tags.name || String(poiKind).replace(/_/g, ' '),
          footprint: G.circleRing(x, y, 1.1, 8), zBase: z, zTop: z + 2.2,
          collision: 'none', use: String(poiKind).replace(/_/g, ' '),
          props: { poi: true, osm: { type: el.type, id: el.id, tags } },
        }, el);
        stats.markers = (stats.markers || 0) + 1;
        continue;
      }
      if (tags.natural === 'tree') {
        const [x, y] = toLocal(el);
        const z = place.groundAt(x, y);
        add({
          type: 'tree', name: tags.species || 'Tree',
          footprint: G.circleRing(x, y, 2.6, 12), zBase: z, zTop: z + 7,
          collision: 'soft', sim: { canopy: 21, permeability: 0.7 }, props: { canopyRadius: 2.6 },
        }, el);
        stats.trees++;
      }
      continue;
    }

    const geom = el.geometry;
    if (!geom || geom.length < 2) { stats.skipped++; continue; }
    const fullLine = geom.map(toLocal);
    const line = fullLine;
    const closed = geom.length > 2 && Math.abs(geom[0].lat - geom.at(-1).lat) < 1e-9 && Math.abs(geom[0].lon - geom.at(-1).lon) < 1e-9;
    const ring = closed ? dedupeRing(line) : null;

    if (tags.building || tags['building:part']) {
      if (!ring || ring.length < 3 || G.area(ring) < 2) { stats.skipped++; continue; }
      const c0 = G.centroid(ring);
      if (!inWindow(c0, window_)) { stats.skipped++; continue; }
      const trimmed = clipRing(ring, window_);
      if (!trimmed || G.area(trimmed) < 2) { stats.skipped++; continue; }
      const c = G.centroid(trimmed);
      const z = place.groundAt(c[0], c[1]);
      const { height, basis } = buildingHeight(tags);
      const roofH = parseFloat(tags['roof:height']);
      const roof = {
        shape: tags['roof:shape'] || null,
        // A roof's height is part of the building's, not on top of it.
        height: Number.isFinite(roofH) ? Math.min(roofH, height * 0.6) : null,
        colour: tags['roof:colour'] || null,
        material: tags['roof:material'] || null,
      };
      const address = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ') || null;
      add({
        type: 'structure',
        name: tags.name || address || 'Building',
        footprint: trimmed, zBase: z, zTop: z + height,
        use: tags.amenity || tags.shop || tags.office || tags.building,
        material: tags['building:material'] || tags['building'] || null,
        collision: 'solid', sim: { permeability: 0, roughness: 0.02 },
        props: {
          heightBasis: basis, roof, address,
          colour: tags['building:colour'] || null,
          levels: parseFloat(tags['building:levels']) || null,
          osm: { type: el.type, id: el.id, tags },
        },
      }, el);
      stats.buildings++;
      continue;
    }

    if (tags.railway && !tags.highway) {
      const pieces = clipToBox(fullLine, window_);
      if (!pieces.length) { stats.skipped++; continue; }
      const line = pieces[0];
      const z = place.groundAt(line[0][0], line[0][1]);
      add({
        type: 'rail', name: tags.name || tags.railway.replace(/_/g, ' '),
        path: line, width: tags.railway === 'tram' ? 3 : 4.5,
        zBase: z, zTop: z + 0.3, network: 'rail', collision: 'none',
      }, el);
      stats.rail = (stats.rail || 0) + 1;
      continue;
    }

    if (tags.highway) {
      const isPath = PATH_KINDS.has(tags.highway);
      const width = parseFloat(tags.width) || (parseFloat(tags.lanes) ? parseFloat(tags.lanes) * 3.2 : null) || ROAD_WIDTH[tags.highway] || 5;
      const pieces = clipToBox(fullLine, window_);
      if (!pieces.length) { stats.skipped++; continue; }
      for (const [pi, piece] of pieces.entries()) {
      const z = place.groundAt(piece[0][0], piece[0][1]);
      add({
        // An unnamed lane is unnamed. Calling it "residential" would put a
        // street name in the world that nobody uses.
        id: pieces.length > 1 ? `osm_${el.type[0]}${el.id}_${pi}` : undefined,
        type: isPath ? 'path' : 'road', name: tags.name || null,
        path: piece, width,
        zBase: z, zTop: z + 0.05,
        network: isPath ? 'paths' : 'streets',
        use: tags.highway.replace(/_/g, ' '),
        collision: 'none',
        sim: { permeability: tags.surface === 'unpaved' || tags.surface === 'ground' ? 0.4 : 0.15, roughness: 0.02 },
        props: { surface: tags.surface || null, osm: { type: el.type, id: el.id, tags } },
      }, el);
      isPath ? stats.paths++ : stats.roads++;
      }
      continue;
    }

    if (tags.waterway) {
      const width = parseFloat(tags.width) || (tags.waterway === 'river' ? 12 : tags.waterway === 'stream' ? 3 : 1.5);
      const pieces = clipToBox(fullLine, window_);
      if (!pieces.length) { stats.skipped++; continue; }
      const line2 = pieces[0];
      const z = place.groundAt(line2[0][0], line2[0][1]);
      add({
        type: tags.waterway === 'ditch' || tags.waterway === 'drain' ? 'drain' : 'stream',
        name: tags.name || null, use: tags.waterway, path: line2, width,
        zBase: z - (tags.waterway === 'river' ? 2 : 0.8), zTop: z,
        network: 'drainage', collision: 'none',
        sim: { capacity: width * 0.8, permeability: 0.1 },
      }, el);
      stats.water++;
      continue;
    }

    if (ring && ring.length >= 3 && G.area(ring) > 4) {
      const trimmed = clipRing(ring, window_);
      if (!trimmed || G.area(trimmed) < 4) { stats.skipped++; continue; }
      const c = G.centroid(trimmed);
      const z = place.groundAt(c[0], c[1]);
      if (tags.natural === 'water') {
        add({ type: 'water', name: tags.name || 'Water', footprint: trimmed, zBase: z - 1, zTop: z, collision: 'none', sim: { capacity: 999 } }, el);
        stats.water++;
      } else if (tags.barrier) {
        add({ type: 'wall', name: tags.barrier, footprint: trimmed, zBase: z, zTop: z + 2, collision: 'solid' }, el);
        stats.walls++;
      } else {
        const permeable = /grass|wood|forest|meadow|scrub|farmland|park|recreation|cemetery|allotments|village_green/.test(`${tags.landuse} ${tags.natural} ${tags.leisure}`);
        add({
          type: 'surface', subtype: tags.landuse || tags.natural || 'ground',
          name: tags.name || tags.landuse || tags.natural || 'Ground',
          footprint: trimmed, zBase: z - 0.02, zTop: z, collision: 'none',
          sim: { permeability: permeable ? 0.7 : 0.2, roughness: permeable ? 0.3 : 0.05 },
        }, el);
        stats.surfaces++;
      }
      continue;
    }

    if (tags.barrier && fullLine.length >= 2) {
      const pieces = clipToBox(fullLine, window_);
      if (!pieces.length) { stats.skipped++; continue; }
      const z = place.groundAt(pieces[0][0][0], pieces[0][0][1]);
      add({ type: 'wall', name: tags.barrier, path: pieces[0], width: 0.3, zBase: z, zTop: z + 2, collision: 'solid' }, el);
      stats.walls++;
      continue;
    }

    stats.skipped++;
  }

  // Landmarks a person can point at by name, taken from what OSM actually names.
  for (const e of place.entities.values()) {
    const ring = place.ringOf(e);
    if (!ring || !e.name || e.name === 'Building') continue;
    if (!['stream', 'water', 'road'].includes(e.type)) continue;
    place.landmarks.set(e.name.toLowerCase(), G.centroid(ring));
  }

  world.dirty = true;
  world.reindex(true);
  return { world, stats };
}

/**
 * Overpass returns whole ways that merely touch the box, so a road crossing a
 * 1 km window comes back 4 km long. Left alone, the place's bounds no longer
 * match the extent it claims and geometry sits beyond its own terrain. Lines are
 * therefore trimmed to the window, splitting into pieces where they leave and
 * re-enter.
 */
const inWindow = (p, box) => p[0] >= box[0] && p[0] <= box[2] && p[1] >= box[1] && p[1] <= box[3];

/**
 * Sutherland–Hodgman: trim a closed ring to the window rather than dropping it.
 * A landuse polygon that runs a kilometre past the edge is still real; it just
 * is not all of it in this place.
 */
function clipRing(ring, box) {
  const edges = [
    { inside: (p) => p[0] >= box[0], cut: (a, b) => cutX(a, b, box[0]) },
    { inside: (p) => p[0] <= box[2], cut: (a, b) => cutX(a, b, box[2]) },
    { inside: (p) => p[1] >= box[1], cut: (a, b) => cutY(a, b, box[1]) },
    { inside: (p) => p[1] <= box[3], cut: (a, b) => cutY(a, b, box[3]) },
  ];
  let out = ring;
  for (const e of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i], prev = input[(i - 1 + input.length) % input.length];
      const cin = e.inside(cur), pin = e.inside(prev);
      if (cin) {
        if (!pin) out.push(e.cut(prev, cur));
        out.push(cur);
      } else if (pin) out.push(e.cut(prev, cur));
    }
    if (!out.length) return null;
  }
  return out.length >= 3 ? out : null;
}
const cutX = (a, b, x) => [x, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0] || 1e-9)];
const cutY = (a, b, y) => [a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1] || 1e-9), y];

function clipToBox(line, box) {
  // Liang–Barsky per segment. A straight road whose only two vertices lie
  // outside the window still crosses it, and dropping it left the place with
  // three roads instead of eighty-seven.
  const runs = [];
  let cur = [];
  const near = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
  const push = (p) => { if (!cur.length || !near(cur[cur.length - 1], p)) cur.push(p); };

  for (let i = 0; i < line.length - 1; i++) {
    const clipped = clipSegment(line[i], line[i + 1], box);
    if (!clipped) {                       // this segment misses the window entirely
      if (cur.length >= 2) runs.push(cur);
      cur = [];
      continue;
    }
    const [a, b] = clipped;
    if (cur.length && !near(cur[cur.length - 1], a)) { if (cur.length >= 2) runs.push(cur); cur = []; }
    push(a); push(b);
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

/** The portion of one segment inside the box, or null. */
function clipSegment(p0, p1, box) {
  let t0 = 0, t1 = 1;
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const tests = [[-dx, p0[0] - box[0]], [dx, box[2] - p0[0]], [-dy, p0[1] - box[1]], [dy, box[3] - p0[1]]];
  for (const [p, q] of tests) {
    if (Math.abs(p) < 1e-12) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
    else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [
    [p0[0] + dx * t0, p0[1] + dy * t0],
    [p0[0] + dx * t1, p0[1] + dy * t1],
  ];
}

function dedupeRing(line) {
  const out = [];
  for (const p of line) {
    const last = out[out.length - 1];
    if (!last || G.dist(last, p) > 1e-6) out.push(p);
  }
  if (out.length > 2 && G.dist(out[0], out[out.length - 1]) < 1e-6) out.pop();
  return out;
}


