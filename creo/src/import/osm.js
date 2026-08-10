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
// Data © OpenStreetMap contributors, ODbL. Elevation from opentopodata.org.

import * as G from '../core/geom.js';
import { Place, Heightfield, makeEntity } from '../core/place.js';
import { World } from '../core/world.js';

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
  node["natural"="tree"](${b});
  node["amenity"](${b});
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
export function osmToPlace(osm, { key, name, bbox, elevation = null, fetchedAt = null, mirror = null }) {
  const anchor = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  const place = new Place({ id: key, name, anchor, seed: 1 });
  place.meta = {
    source: 'OpenStreetMap',
    licence: 'ODbL — © OpenStreetMap contributors',
    bbox, fetchedAt, mirror,
    elevation: elevation ? elevation.attribution : 'none — treated as flat',
  };
  const P = place.projection;
  const toLocal = (n) => P.toLocal(n.lat, n.lon);

  // Terrain first: everything else sits on it.
  const bb = [
    ...P.toLocal(bbox[0], bbox[1]),
    ...P.toLocal(bbox[2], bbox[3]),
  ];
  const bounds = [Math.min(bb[0], bb[2]), Math.min(bb[1], bb[3]), Math.max(bb[0], bb[2]), Math.max(bb[1], bb[3])];
  place.terrain = elevation
    ? heightfieldFrom(elevation, P, bounds)
    : new Heightfield(bounds, 10);

  const world = new World(place);
  const stats = { buildings: 0, roads: 0, paths: 0, water: 0, surfaces: 0, trees: 0, walls: 0, skipped: 0 };

  const add = (spec, el) => {
    const e = makeEntity({
      id: `osm_${el.type[0]}${el.id}`,
      source: 'OpenStreetMap',
      epistemic: 'IMPORTED',
      author: 'OpenStreetMap contributors',
      evidence: [{ kind: 'osm', ref: `${el.type}/${el.id}`, tags: el.tags || {}, fetchedAt }],
      props: { osm: { type: el.type, id: el.id, tags: el.tags || {} } },
      ...spec,
    });
    place.put(e, 'AS_IS');
    return e;
  };

  for (const el of osm.elements) {
    const tags = el.tags || {};

    if (el.type === 'node') {
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
    const line = geom.map(toLocal);
    const closed = geom.length > 2 && Math.abs(geom[0].lat - geom.at(-1).lat) < 1e-9 && Math.abs(geom[0].lon - geom.at(-1).lon) < 1e-9;
    const ring = closed ? dedupeRing(line) : null;

    if (tags.building || tags['building:part']) {
      if (!ring || ring.length < 3 || G.area(ring) < 2) { stats.skipped++; continue; }
      const c = G.centroid(ring);
      const z = place.groundAt(c[0], c[1]);
      const { height, basis } = buildingHeight(tags);
      add({
        type: 'structure', name: tags.name || tags['addr:housenumber'] || 'Building',
        footprint: ring, zBase: z, zTop: z + height,
        use: tags.amenity || tags.shop || tags.office || tags.building,
        material: tags['building:material'] || null,
        collision: 'solid', sim: { permeability: 0, roughness: 0.02 },
        props: { heightBasis: basis, osm: { type: el.type, id: el.id, tags } },
      }, el);
      stats.buildings++;
      continue;
    }

    if (tags.highway) {
      const isPath = PATH_KINDS.has(tags.highway);
      const width = parseFloat(tags.width) || (parseFloat(tags.lanes) ? parseFloat(tags.lanes) * 3.2 : null) || ROAD_WIDTH[tags.highway] || 5;
      const z = place.groundAt(line[0][0], line[0][1]);
      add({
        type: isPath ? 'path' : 'road', name: tags.name || tags.highway.replace(/_/g, ' '),
        path: line, width,
        zBase: z, zTop: z + 0.05,
        network: isPath ? 'paths' : 'streets',
        use: tags.name ? undefined : tags.highway,
        collision: 'none',
        sim: { permeability: tags.surface === 'unpaved' || tags.surface === 'ground' ? 0.4 : 0.15, roughness: 0.02 },
        props: { surface: tags.surface || null, osm: { type: el.type, id: el.id, tags } },
      }, el);
      isPath ? stats.paths++ : stats.roads++;
      continue;
    }

    if (tags.waterway) {
      const width = parseFloat(tags.width) || (tags.waterway === 'river' ? 12 : tags.waterway === 'stream' ? 3 : 1.5);
      const z = place.groundAt(line[0][0], line[0][1]);
      add({
        type: tags.waterway === 'ditch' || tags.waterway === 'drain' ? 'drain' : 'stream',
        name: tags.name || tags.waterway, path: line, width,
        zBase: z - (tags.waterway === 'river' ? 2 : 0.8), zTop: z,
        network: 'drainage', collision: 'none',
        sim: { capacity: width * 0.8, permeability: 0.1 },
      }, el);
      stats.water++;
      continue;
    }

    if (ring && ring.length >= 3 && G.area(ring) > 4) {
      const c = G.centroid(ring);
      const z = place.groundAt(c[0], c[1]);
      if (tags.natural === 'water') {
        add({ type: 'water', name: tags.name || 'Water', footprint: ring, zBase: z - 1, zTop: z, collision: 'none', sim: { capacity: 999 } }, el);
        stats.water++;
      } else if (tags.barrier) {
        add({ type: 'wall', name: tags.barrier, footprint: ring, zBase: z, zTop: z + 2, collision: 'solid' }, el);
        stats.walls++;
      } else {
        const permeable = /grass|wood|forest|meadow|scrub|farmland|park|recreation|cemetery|allotments|village_green/.test(`${tags.landuse} ${tags.natural} ${tags.leisure}`);
        add({
          type: 'surface', subtype: tags.landuse || tags.natural || 'ground',
          name: tags.name || tags.landuse || tags.natural || 'Ground',
          footprint: ring, zBase: z - 0.02, zTop: z, collision: 'none',
          sim: { permeability: permeable ? 0.7 : 0.2, roughness: permeable ? 0.3 : 0.05 },
        }, el);
        stats.surfaces++;
      }
      continue;
    }

    if (tags.barrier && line.length >= 2) {
      const z = place.groundAt(line[0][0], line[0][1]);
      add({ type: 'wall', name: tags.barrier, path: line, width: 0.3, zBase: z, zTop: z + 2, collision: 'solid' }, el);
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

function dedupeRing(line) {
  const out = [];
  for (const p of line) {
    const last = out[out.length - 1];
    if (!last || G.dist(last, p) > 1e-6) out.push(p);
  }
  if (out.length > 2 && G.dist(out[0], out[out.length - 1]) < 1e-6) out.pop();
  return out;
}

function heightfieldFrom(elevation, projection, bounds) {
  const { points, spacing } = elevation;
  const hf = new Heightfield(bounds, spacing);
  // Inverse-distance interpolation from the sampled DEM points.
  const local = points.map((p) => ({ xy: projection.toLocal(p.lat, p.lon), z: p.elevation }));
  const base = Math.min(...local.map((p) => p.z));
  for (let j = 0; j < hf.ny; j++) {
    for (let i = 0; i < hf.nx; i++) {
      const x = bounds[0] + i * hf.cell, y = bounds[1] + j * hf.cell;
      let num = 0, den = 0;
      for (const p of local) {
        const d2 = (p.xy[0] - x) ** 2 + (p.xy[1] - y) ** 2;
        if (d2 < 1e-6) { num = p.z; den = 1; break; }
        const w = 1 / (d2 * d2);
        num += p.z * w; den += w;
      }
      // Store metres above the lowest sampled point: local relief is what the
      // water model needs, and absolute altitude would only add noise.
      hf.data[hf.idx(i, j)] = (den ? num / den : base) - base;
    }
  }
  hf.__datum = base;
  return hf;
}
