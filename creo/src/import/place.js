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

export function slug(s) {
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
    throw new Error('OpenStreetMap has nothing mapped here — try somewhere else, or a wider area');
  }

  // 3. the ground it is built on
  let terrain = null;
  if (opts.terrain !== false) {
    try {
      const projection = makeProjection((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2);
      terrain = await sampleTerrain(bbox, projection, localBounds(projection, bbox), { fetchImpl, log });
      log(`terrain: ${terrain.attribution}`);
    } catch (err) {
      log(`terrain unavailable (${String(err.message).slice(0, 70)}) — the ground will be level`);
    }
  }

  // 4. become a place
  const fetchedAt = new Date().toISOString();
  const { world, stats } = osmToPlace(json, { key, name: name || key, bbox, terrain, fetchedAt, mirror });
  world.place.meta.geocoded = resolved ? { query: opts.query, match: resolved.name, osm: resolved.osm } : null;

  if (!stats.buildings && !stats.roads) {
    throw new Error('nothing usable here — OpenStreetMap has no buildings or roads mapped in this area');
  }
  log(`built: ${Object.entries(stats).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  return { world, stats, bbox, key, name: name || key, resolved, fetchedAt, span };
}

export { geocode, resolvePlace };
