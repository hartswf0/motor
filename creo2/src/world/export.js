// EXPORT READS THE PLACE MODEL.
//
// Everything CREO knows is metres on a local tangent plane anchored to a real
// latitude and longitude, so it can leave the screen as ordinary GIS data —
// with its provenance attached, because an entity that cannot say where it came
// from is not worth exporting.

import * as G from '../core/geom.js';

const round = (v, p = 9) => +v.toFixed(p);

/**
 * @param {World} world
 * @param {{branch?:string, includeObservations?:boolean}} opts
 * @returns {object} a WGS84 FeatureCollection
 */
export function toGeoJSON(world, opts = {}) {
  const branch = opts.branch || world.branch;
  const view = branch === world.branch ? { entities: world.entities() } : world.view(branch);
  const proj = world.place.projection;
  const features = [];

  for (const e of view.entities) {
    if (e.type === 'observation' && opts.includeObservations === false) continue;
    const geometry = geometryOf(world, e, proj);
    if (!geometry) continue;
    features.push({
      type: 'Feature',
      id: e.id,
      geometry,
      properties: {
        id: e.id, type: e.type, subtype: e.subtype, name: e.name,
        use: e.use, material: e.material, network: e.network, parent: e.parent,
        // vertical interval, in metres above the local datum
        z_base: round(e.zBase, 3), z_top: round(e.zTop, 3), height: round(e.zTop - e.zBase, 3),
        width_m: e.width ?? null,
        area_m2: e.footprint || e.path ? round(G.area(world.place.ringOf(e)), 2) : null,
        // epistemics travel with the geometry: this is the point of the model
        epistemic: e.epistemic, certainty: e.certainty, status: e.status,
        author: e.author, source: e.source, branch,
        said: e.evidence?.find((v) => v.kind === 'utterance')?.text || null,
        said_lang: e.evidence?.find((v) => v.kind === 'utterance')?.lang || null,
        disputed_by: world.place.relations
          .filter((r) => r.kind === 'disputedBy' && r.to === e.id).map((r) => r.from).join(', ') || null,
        preserved: world.place.relations.some((r) => r.kind === 'preserves' && r.to === e.id) || null,
      },
    });
  }

  return {
    type: 'FeatureCollection',
    name: `${world.place.name} — ${world.place.branches.get(branch)?.name || branch}`,
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
    metadata: {
      place: world.place.id,
      anchor: { lat: proj.anchor[0], lon: proj.anchor[1] },
      branch,
      tick: world.place.tick,
      generator: 'CREO',
      note: 'Local ENU metres re-projected to WGS84 about the anchor. Vertical values remain metres above the local datum.',
    },
    features,
  };
}

function geometryOf(world, e, proj) {
  const toLonLat = ([x, y]) => {
    const [lat, lon] = proj.toWGS84(x, y);
    return [round(lon), round(lat)];               // GeoJSON is lon, lat
  };
  if (e.path && !e.footprint) {
    return { type: 'LineString', coordinates: e.path.map(toLonLat) };
  }
  const ring = world.place.ringOf(e);
  if (!ring || ring.length < 3) return null;
  const closed = ring.concat([ring[0]]);
  return { type: 'Polygon', coordinates: [closed.map(toLonLat)] };
}

/** Read a FeatureCollection back into local metres — the inverse, for round-trip checks. */
export function fromGeoJSON(fc, world) {
  const proj = world.place.projection;
  return fc.features.map((f) => {
    const coords = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates;
    const local = coords.map(([lon, lat]) => proj.toLocal(lat, lon));
    if (f.geometry.type === 'Polygon') local.pop();          // drop the repeated closing vertex
    return { id: f.id, properties: f.properties, local };
  });
}
