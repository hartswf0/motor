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
  relation["waterway"](${b});
  way["natural"~"water|wood|scrub|wetland|bay|strait|beach|coastline"](${b});
  relation["natural"~"water|wetland|bay"](${b});
  way["landuse"~"reservoir|basin"](${b});
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
export async function fetchOSM(bbox, opts = {}) {
  const { mirrors = MIRRORS, fetchImpl = fetch, rounds = 4, log = () => {} } = opts;
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
          body: new URLSearchParams({ data: (opts.query || overpassQuery)(bbox) }),
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

/**
 * Permanent water is part of the world. It is not the flood model, which is a
 * temporary condition drawn on top. Everything here is IMPORTED hydrography and
 * is visible whether or not anyone has asked about rain.
 */
const WATERWAY_KIND = {
  river: 'river', stream: 'stream', canal: 'canal', drain: 'drain',
  ditch: 'ditch', brook: 'stream', tidal_channel: 'channel',
};
function waterKind(tags) {
  if (tags.natural === 'coastline') return 'coastline';
  if (tags.natural === 'bay' || tags.natural === 'strait') return 'bay';
  if (tags.landuse === 'reservoir' || tags.landuse === 'basin') return 'reservoir';
  if (tags.natural === 'wetland') return 'wetland';
  if (tags.natural === 'water') return tags.water || 'lake';
  if (tags.waterway) return WATERWAY_KIND[tags.waterway] || 'stream';
  return null;
}
/** Constructed drainage participates in the causal graph; a lake does not. */
const IS_DRAINAGE = new Set(['drain', 'ditch', 'canal']);

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
  // Centimetres. OSM knows these positions to about a metre; carrying fifteen
  // significant figures of them turned a dense quarter into a 23 MB file.
  const cm = (v) => Math.round(v * 100) / 100;
  const toLocal = (n) => { const [x, y] = P.toLocal(n.lat, n.lon); return [cm(x), cm(y)]; };

  // Terrain first: everything else sits on it.
  const bounds = localBounds(P, bbox);
  // A small margin so a building on the edge is not sliced off, but not so much
  // that the place sprawls past the ground beneath it.
  const pad = 0.06 * Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1]);
  const window_ = [bounds[0] - pad, bounds[1] - pad, bounds[2] + pad, bounds[3] + pad];
  place.terrain = terrain ? terrain.heightfield : new Heightfield(bounds, 10);

  const world = new World(place);
  const stats = { buildings: 0, roads: 0, paths: 0, water: 0, surfaces: 0, trees: 0, walls: 0, skipped: 0 };
  const coastlines = [];

  // The citation is the OSM reference, not a copy of every tag: way/25400176 can
  // always be looked up. Storing the full tag dictionary twice — once in
  // evidence, once in props — made a dense quarter a 24 MB file.
  const KEEP_TAGS = ['name', 'building', 'building:levels', 'height', 'roof:shape', 'roof:height',
    'building:colour', 'building:material', 'highway', 'waterway', 'natural', 'water', 'landuse',
    'surface', 'width', 'lanes', 'amenity', 'shop', 'barrier', 'railway', 'addr:street', 'addr:housenumber'];
  const slimTags = (tags = {}) => {
    const out = {};
    for (const k of KEEP_TAGS) if (tags[k] !== undefined) out[k] = tags[k];
    return out;
  };

  const add = (spec, el) => {
    // Pull the id out first: spreading a spec whose id is undefined used to
    // erase the OSM id, and every entity then landed under the same key.
    const { id: specId, ...rest } = spec;
    const e = makeEntity({
      id: specId || `osm_${el.type[0]}${el.id}`,
      source: 'OpenStreetMap',
      epistemic: 'IMPORTED',
      author: 'OpenStreetMap contributors',
      evidence: [{ kind: 'osm', ref: `${el.type}/${el.id}`, fetchedAt }],
      props: { osm: { type: el.type, id: el.id, tags: slimTags(el.tags) } },
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
          props: { poi: true, osm: { type: el.type, id: el.id, tags: slimTags(tags) } },
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

    // A lake of any size is usually a multipolygon relation, not a way. Taking
    // only ways is why large water was missing entirely.
    if (el.type === 'relation') {
      const outers = (el.members || []).filter((m) => m.role !== 'inner' && m.geometry && m.geometry.length > 2);
      if (!outers.length) { stats.skipped++; continue; }
      const kind = waterKind(tags);
      for (const [mi, m] of outers.entries()) {
        const ringM = dedupeRing(m.geometry.map(toLocal));
        if (ringM.length < 3) continue;
        const trimmedM = clipRing(ringM, window_);
        if (!trimmedM || G.area(trimmedM) < 6) continue;
        const cM = G.centroid(trimmedM);
        const zM = place.groundAt(cM[0], cM[1]);
        if (kind) {
          add({
            id: `osm_r${el.id}_${mi}`, type: 'water', subtype: kind,
            name: tags.name || null, footprint: trimmedM,
            zBase: zM - depthFor(kind), zTop: zM, collision: 'none',
            network: IS_DRAINAGE.has(kind) ? 'drainage' : null,
            sim: { capacity: 999, permeability: 0.02 },
          }, el);
          stats.water++;
        } else if (tags.building) {
          add({ id: `osm_r${el.id}_${mi}`, type: 'structure', name: tags.name || 'Building',
                footprint: trimmedM,
                ...(() => {
                  const sp = G.groundSpan(trimmedM, (x, y) => place.groundAt(x, y)) || { lo: zM, hi: zM };
                  const hgt = buildingHeight(tags).height;
                  return { zBase: sp.lo, zTop: sp.hi + hgt, height: hgt, groundFall: +(sp.hi - sp.lo).toFixed(2) };
                })(),
                collision: 'solid', sim: { permeability: 0, roughness: 0.02 },
                props: { heightBasis: buildingHeight(tags).basis, osm: { type: el.type, id: el.id, tags: slimTags(tags) } } }, el);
          stats.buildings++;
        }
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
      const { height, basis } = buildingHeight(tags);
      // A building is level; the ground under it is not. Taking one height at
      // the centroid leaves the downhill corner in mid-air and the uphill
      // corner buried. Sit the foundation on the LOWEST ground it covers and
      // carry the roof clear of the HIGHEST, which is what a real building on a
      // slope does: a plinth downhill, a short elevation uphill.
      const span = G.groundSpan(trimmed, (x, y) => place.groundAt(x, y)) || { lo: place.groundAt(c[0], c[1]), hi: place.groundAt(c[0], c[1]) };
      const fall = span.hi - span.lo;
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
        footprint: trimmed, zBase: span.lo, zTop: span.hi + height,
        // the height it was given, kept apart from the extent it now occupies
        height, groundFall: +fall.toFixed(2),
        use: tags.amenity || tags.shop || tags.office || tags.building,
        material: tags['building:material'] || tags['building'] || null,
        collision: 'solid', sim: { permeability: 0, roughness: 0.02 },
        props: {
          heightBasis: basis, roof, address,
          colour: tags['building:colour'] || null,
          levels: parseFloat(tags['building:levels']) || null,
          osm: { type: el.type, id: el.id, tags: slimTags(tags) },
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
        props: { surface: tags.surface || null, osm: { type: el.type, id: el.id, tags: slimTags(tags) } },
      }, el);
      isPath ? stats.paths++ : stats.roads++;
      }
      continue;
    }

    if (tags.natural === 'coastline') {
      coastlines.push(fullLine);
      stats.water++;
      continue;
    }

    if (tags.waterway) {
      const width = parseFloat(tags.width) || (tags.waterway === 'river' ? 12 : tags.waterway === 'stream' ? 3 : 1.5);
      const pieces = clipToBox(fullLine, window_);
      if (!pieces.length) { stats.skipped++; continue; }
      // Every piece, not just the first. A creek that leaves the window and
      // comes back is several pieces, and keeping pieces[0] silently threw the
      // rest of the watercourse away — the roads directly above this already
      // loop, so the water was the odd one out.
      for (const line2 of pieces) {
      const z = place.groundAt(line2[0][0], line2[0][1]);
      const kind = waterKind(tags) || 'stream';
      add({
        type: IS_DRAINAGE.has(kind) && kind !== 'canal' ? 'drain' : 'water',
        subtype: kind,
        name: tags.name || null, use: tags.waterway, path: line2, width,
        zBase: z - depthFor(kind), zTop: z,
        network: 'drainage', collision: 'none',
        sim: { capacity: width * 0.8, permeability: 0.1 },
      }, el);
      stats.water++;
      }
      continue;
    }

    if (ring && ring.length >= 3 && G.area(ring) > 4) {
      const trimmed = clipRing(ring, window_);
      if (!trimmed || G.area(trimmed) < 4) { stats.skipped++; continue; }
      const c = G.centroid(trimmed);
      const z = place.groundAt(c[0], c[1]);
      const areaKind = waterKind(tags);
      if (areaKind) {
        add({
          type: 'water', subtype: areaKind, name: tags.name || null,
          footprint: trimmed, zBase: z - depthFor(areaKind), zTop: z,
          collision: 'none', network: IS_DRAINAGE.has(areaKind) ? 'drainage' : null,
          sim: { capacity: 999, permeability: 0.02 },
        }, el);
        stats.water++;
      } else if (tags.barrier) {
        const wallSpan = G.groundSpan(trimmed, (x, y) => place.groundAt(x, y)) || { lo: z, hi: z };
        add({ type: 'wall', name: tags.barrier, footprint: trimmed, zBase: wallSpan.lo, zTop: wallSpan.hi + 2, collision: 'solid' }, el);
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

  // The sea is not a blue line. OSM draws a coastline with land on its left, so
  // everything to its right, out to the edge of the window, is ocean.
  if (coastlines.length) {
    const sea = seaFromCoastlines(coastlines, window_);
    for (const [i, ring] of sea.entries()) {
      const c = G.centroid(ring);
      add({
        id: `sea_${i}`, type: 'water', subtype: 'ocean', name: 'Sea',
        footprint: ring, zBase: -4, zTop: 0, collision: 'none',
        sim: { capacity: 9999, permeability: 0 },
        props: { derivedFrom: 'natural=coastline' },
      }, { type: 'way', id: `coast${i}`, tags: { natural: 'coastline' } });
    }
    if (sea.length) stats.ocean = sea.length;
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

/** How deep the world's water sits below the ground beside it. */
function depthFor(kind) {
  return { ocean: 4, lake: 3, pond: 1.2, reservoir: 4, river: 2.5, canal: 2,
           stream: 0.8, drain: 0.8, ditch: 0.6, wetland: 0.2, bay: 4, channel: 1.5 }[kind] ?? 1;
}

/**
 * Close each coastline against the window on its seaward side.
 *
 * OSM's convention is that land lies to the LEFT of a coastline way's direction,
 * so the sea is to the right. Rather than infer the side from winding — which is
 * easy to get backwards — both closures are built and the one that actually
 * contains a point sampled just off the coast to starboard is the sea.
 */
export function __test_sea(lines, box) { return seaFromCoastlines(lines, box); }

function seaFromCoastlines(rawLines, box) {
  // OSM splits a shore into many ways that meet end to end. Each one taken
  // alone often begins or ends inside the window and can close against nothing,
  // which is why no sea appeared at all. Join them first.
  const lines = stitch(rawLines, 1.0);
  const out = [];
  for (const full of lines) {
    for (const piece of clipToBox(full, box)) {
      if (piece.length < 2) continue;
      const a = piece[0], b = piece[piece.length - 1];
      if (G.dist(a, b) < 1) continue;                      // an island, not a shore
      // A chain that stops just inside the window is extended along its own
      // heading until it meets the edge — the shore does not simply end there.
      const ext = piece.slice();
      if (!onBoundary(ext[0], box)) {
        const p = toEdge(ext[0], G.norm(G.sub(ext[0], ext[1])), box);
        if (!p) continue;
        ext.unshift(p);
      }
      if (!onBoundary(ext[ext.length - 1], box)) {
        const p = toEdge(ext[ext.length - 1], G.norm(G.sub(ext[ext.length - 1], ext[ext.length - 2])), box);
        if (!p) continue;
        ext.push(p);
      }
      piece.length = 0;
      piece.push(...ext);

      // a point just to starboard of the middle of the coast: that is water
      const mid = Math.floor(piece.length / 2);
      const p0 = piece[Math.max(0, mid - 1)], p1 = piece[Math.min(piece.length - 1, mid + 1)];
      const dir = G.norm(G.sub(p1, p0));
      if (!Number.isFinite(dir[0])) continue;
      const starboard = [dir[1], -dir[0]];                 // right of travel
      const probe = [piece[mid][0] + starboard[0] * 2, piece[mid][1] + starboard[1] * 2];

      for (const way of [1, -1]) {
        const ring = piece.concat(boundaryPath(b, a, box, way));
        if (ring.length < 3) continue;
        if (G.area(ring) < 50) continue;
        if (G.pointInRing(probe, ring)) { out.push(G.ensureCCW(ring)); break; }
      }
    }
  }
  return out;
}

/** Join polylines that share an endpoint into the longest chains available. */
function stitch(lines, tol) {
  const pool = lines.map((l) => l.slice()).filter((l) => l.length >= 2);
  const out = [];
  const near = (a, b) => G.dist(a, b) <= tol;
  while (pool.length) {
    let cur = pool.pop();
    let joined = true;
    while (joined) {
      joined = false;
      for (let i = 0; i < pool.length; i++) {
        const other = pool[i];
        const [cs, ce] = [cur[0], cur[cur.length - 1]];
        const [os, oe] = [other[0], other[other.length - 1]];
        if (near(ce, os)) { cur = cur.concat(other.slice(1)); }
        else if (near(ce, oe)) { cur = cur.concat(other.slice(0, -1).reverse()); }
        else if (near(cs, oe)) { cur = other.slice(0, -1).concat(cur); }
        else if (near(cs, os)) { cur = other.slice(1).reverse().concat(cur); }
        else continue;
        pool.splice(i, 1);
        joined = true;
        break;
      }
    }
    out.push(cur);
  }
  return out;
}

const onBoundary = (p, box, tol = 0.5) =>
  Math.abs(p[0] - box[0]) < tol || Math.abs(p[0] - box[2]) < tol
  || Math.abs(p[1] - box[1]) < tol || Math.abs(p[1] - box[3]) < tol;

/** March from a point along a heading until the window edge is met. */
function toEdge(p, dir, box) {
  if (!Number.isFinite(dir[0]) || (dir[0] === 0 && dir[1] === 0)) return null;
  const ts = [];
  if (dir[0] !== 0) { ts.push((box[0] - p[0]) / dir[0], (box[2] - p[0]) / dir[0]); }
  if (dir[1] !== 0) { ts.push((box[1] - p[1]) / dir[1], (box[3] - p[1]) / dir[1]); }
  const t = ts.filter((v) => v > 1e-6).sort((a, b) => a - b)[0];
  if (!Number.isFinite(t)) return null;
  return [p[0] + dir[0] * t, p[1] + dir[1] * t];
}

/** Position of a boundary point around the window perimeter, in [0,4). */
function perimeterT(p, box) {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0 || 1, h = y1 - y0 || 1;
  if (Math.abs(p[1] - y0) <= Math.abs(p[1] - y1) && Math.abs(p[1] - y0) < 1) return (p[0] - x0) / w;
  if (Math.abs(p[0] - x1) < 1) return 1 + (p[1] - y0) / h;
  if (Math.abs(p[1] - y1) < 1) return 2 + (x1 - p[0]) / w;
  return 3 + (y1 - p[1]) / h;
}

/** The corners passed walking the window edge from one point to another. */
function boundaryPath(from, to, box, direction) {
  const [x0, y0, x1, y1] = box;
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];   // the corner at integer t = k is corners[k]
  let t = perimeterT(from, box);
  const target = perimeterT(to, box);
  const path = [];
  for (let n = 0; n < 5; n++) {
    const next = direction > 0 ? Math.floor(t) + 1 : Math.ceil(t) - 1;
    const reached = direction > 0
      ? (target > t && target <= next) || (target < t && next >= 4 && target + 4 <= next)
      : (target < t && target >= next) || (target > t && next <= 0 && target - 4 >= next);
    if (reached) break;
    // The corner reached is the one AT t = next, whichever way we are walking.
    const idx = ((next % 4) + 4) % 4;
    path.push(corners[idx]);
    t = ((next % 4) + 4) % 4;
  }
  return path;
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




/**
 * THE SKELETON — enough of the wider world to know where you are.
 *
 * The plan shows kilometres of ground and nothing on it, because detail is only
 * fetched for a small window. But orientation does not need detail: it needs the
 * main road, the river, and the name of the next village. That is a tiny query —
 * major ways only, no buildings, no tags to speak of — over an area sixty times
 * larger than the detailed one.
 *
 * What comes back is deliberately NOT put in the world as entities. It is not
 * survey and it is not complete; it is a sketch for finding your way, and
 * calling it anything else would let someone measure against it.
 */
export function skeletonQuery(bbox) {
  const b = `${bbox[0]},${bbox[1]},${bbox[2]},${bbox[3]}`;
  return `[out:json][timeout:40];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"](${b});
  way["waterway"~"^(river|stream)$"](${b});
  way["natural"="water"](${b});
  node["place"~"^(city|town|village|hamlet)$"](${b});
);
out geom qt;`;
}

const SKELETON_RANK = {
  motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4,
};

/** Turn that into polylines and labels in the place's own metres. */
export function toSkeleton(json, projection) {
  const ways = [], places = [];
  for (const el of json.elements || []) {
    const tags = el.tags || {};
    if (el.type === 'node' && tags.place) {
      const [x, y] = projection.toLocal(el.lat, el.lon);
      places.push({ at: [Math.round(x), Math.round(y)], name: tags.name || null, kind: tags.place });
      continue;
    }
    if (!el.geometry || el.geometry.length < 2) continue;
    const line = el.geometry.map((g) => projection.toLocal(g.lat, g.lon).map((v) => Math.round(v)));
    if (tags.highway) {
      ways.push({ line, kind: 'road', rank: SKELETON_RANK[tags.highway] ?? 5, name: tags.name || null });
    } else if (tags.waterway || tags.natural === 'water') {
      ways.push({ line, kind: 'water', rank: 6, name: tags.name || null, area: tags.natural === 'water' });
    }
  }
  return {
    ways, places,
    note: 'for finding your way, not for measuring: major ways only, no buildings',
  };
}
