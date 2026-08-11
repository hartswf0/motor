// IMPORT ANY LOCATION.
//
// One orchestrator, used identically by the CLI and by the running app: a name
// or a bounding box goes in, a real World comes out. Nothing here needs a key,
// a server or a build step — Nominatim, Overpass and the terrarium tiles are all
// public, and all three allow browser requests, so the app can do this live.

import { resolvePlace, geocode, bboxMetres, windowAround } from './geocode.js';
import { fetchOSM, osmToPlace, localBounds } from './osm.js';
import { sampleTerrain } from './terrain.js';
import { makeProjection } from '../core/geom.js';

/** Overpass is a shared resource. Refuse politely rather than ask for a city. */
export const MAX_SPAN_M = 2500;

/**
 * A key is an identity, so it must not lose the part that distinguishes it.
 * Truncating at 40 characters cut the width off the end of a widened place —
 * "Watauga Lake, Carter County, United States · 2300 m" and the original 900 m
 * window slugged to the same key, and re-cutting a window silently destroyed
 * the one it came from. Anything after the last "·" is the distinguishing part
 * and is kept whole.
 */
export function slug(s) {
  const str = String(s || '');
  const cut = str.lastIndexOf('·');
  if (cut > 0) {
    const head = plainSlug(str.slice(0, cut)).slice(0, 34);
    const tail = plainSlug(str.slice(cut + 1));
    return tail ? `${head}-${tail}` : head;
  }
  return plainSlug(str);
}

function plainSlug(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'place';
}

/**
 * @param {{query?:string, bbox?:number[], name?:string, key?:string,
 *          metres?:number, terrain?:boolean, fetchImpl?:Function, log?:Function}} opts
 */
export async function importPlace(opts = {}) {
  const log = opts.log || (() => {});
  const fetchImpl = opts.fetchImpl || fetch;
  const metres = opts.metres || 900;

  // 1. where
  let bbox = opts.bbox;
  let name = opts.name;
  let resolved = null;
  if (!bbox) {
    if (!opts.query) throw new Error('give a place name or a bounding box');
    log(`looking up “${opts.query}”…`);
    resolved = await resolvePlace(opts.query, { metres, fetchImpl });
    bbox = resolved.bbox;
    name = name || resolved.short;
    if (resolved.why) log(resolved.why);
    if (resolved.alternatives.length) {
      log(`other matches: ${resolved.alternatives.slice(0, 3).map((a) => a.short).join(' · ')}`);
    }
  }
  const span = bboxMetres(bbox);
  if (span.width > MAX_SPAN_M || span.height > MAX_SPAN_M) {
    const shrunk = windowAround(bbox, MAX_SPAN_M);
    log(`that area is ${Math.round(span.width)}×${Math.round(span.height)} m — narrowing to ${MAX_SPAN_M} m so Overpass is not asked for a city`);
    bbox = shrunk;
  }
  const key = opts.key || slug(name || opts.query);

  // 2. what is built there
  log('reading OpenStreetMap…');
  const { json, mirror } = await fetchOSM(bbox, { fetchImpl, log });
  log(`${json.elements.length} OSM elements`);
  if (!json.elements.length) {
    // Nobody has mapped this. That is a fact about the map, not about the
    // place — and it is often the whole point of going: an empty site, an
    // island, a stretch of coast before anything is on it. Carry on with the
    // ground, and say plainly that everything here will be the person's own.
    log('nobody has mapped this yet — opening the ground alone');
  }

  // 3. THE GROUND IS WIDER THAN THE DETAIL.
  //
  // A Place's extent and the extent of its CONTENTS are different things, and
  // conflating them is what made the countryside unusable: a 900 m window with
  // four farm tracks in it gives nothing to navigate by, and finding a site
  // meant fetching blind tile after blind tile.
  //
  // Elevation is the cheap half. Measured at Watauga Lake: 900 m of ground is
  // one tile and 325 ms; 7.2 KM IS FOUR TILES AND 540 MS — sixty-four times the
  // area for two-thirds again the time, and it carries 505 m of relief. Landform
  // is what you navigate by where there are no landmarks, so take a lot of it.
  //
  // OSM detail stays narrow, because that is the expensive half and the half
  // that has to be asked for.
  const GROUND_MULTIPLE = 8;
  let terrain = null;
  const projection = makeProjection((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2);
  const detailBounds = localBounds(projection, bbox);
  if (opts.terrain !== false) {
    const wide = windowAround(bbox, Math.min(MAX_SPAN_M * GROUND_MULTIPLE,
      Math.max(bboxMetres(bbox).width, bboxMetres(bbox).height) * GROUND_MULTIPLE));
    for (const [attempt, box] of [['wide', wide], ['just the window', bbox]]) {
      try {
        terrain = await sampleTerrain(box, projection, localBounds(projection, box), { fetchImpl, log });
        log(`terrain: ${terrain.attribution}`);
        if (attempt === 'wide') {
          const m = Math.round(bboxMetres(box).width);
          log(`ground carried out to ${m} m so there is landform to navigate by`);
        }
        break;
      } catch (err) {
        if (attempt === 'wide') { log(`wide ground unavailable (${String(err.message).slice(0, 50)}) — trying just the window`); continue; }
        log(`terrain unavailable (${String(err.message).slice(0, 70)}) — the ground will be level`);
      }
    }
  }

  // 4. become a place
  const fetchedAt = new Date().toISOString();
  const { world, stats } = osmToPlace(json, { key, name: name || key, bbox, terrain, fetchedAt, mirror });
  world.place.meta.geocoded = resolved ? { query: opts.query, match: resolved.name, osm: resolved.osm } : null;
  // where the DETAIL is, as opposed to where the ground is. Everything outside
  // this box is real landform with nothing built recorded on it — which is a
  // fact about the map, and must never be shown as a fact about the place.
  world.place.meta.detailBounds = detailBounds;
  world.place.meta.detailBBox = bbox;

  // An unmapped place is still a place. Refusing to open ground because nobody
  // has drawn a building on it was the map talking, not the world: an island, a
  // site before it is built, a stretch of coast — these are exactly the places
  // worth standing in, and the terrain, the water and the coastline are real
  // whether or not OpenStreetMap has been there. What CREO must never do is
  // pretend the emptiness is data, so it says plainly what is and is not known.
  const built = Object.values(stats).reduce((a, b) => a + b, 0) - (stats.skipped || 0);
  if (!built && !terrain) {
    throw new Error('nothing here at all — no map data and no elevation for this spot');
  }
  world.place.meta.sparse = !stats.buildings && !stats.roads;
  if (world.place.meta.sparse) {
    log('OpenStreetMap has nothing built here — opening the ground itself');
  }
  log(`built: ${Object.entries(stats).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  return { world, stats, bbox, key, name: name || key, resolved, fetchedAt, span };
}

export { geocode, resolvePlace };
