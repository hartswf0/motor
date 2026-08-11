// PARCELS — where you may build, which is the first fact about any site.
//
// CREO could describe a hillside in detail and had no idea where anyone was
// allowed to stand on it. Every answer it gave about siting was therefore
// unbounded: it would happily cut a terrace across a boundary it could not see.
// A parcel is not decoration on a map. It is the constraint that makes a siting
// question answerable at all.
//
// Tennessee publishes its property boundaries openly, and other states publish
// theirs; this reads the TN service because that is where the site is. The
// important part is the shape of the thing, not the vendor: a parcel arrives
// with an id, an owner, a deed acreage and a ring, and CREO checks the ring
// against the deed rather than trusting either.

const TN = 'https://services1.arcgis.com/YuVBSS7Y1of2Qud1/arcgis/rest/services'
  + '/Tennessee_Property_Boundaries_Public_Use/FeatureServer/0/query';

/**
 * @param {object} q  { county, map, parcel } or { at: [lat, lon] }
 * @returns {Promise<{ring:number[][], attrs:object, centre:number[], acres:number}>}
 */
export async function findParcel(q, { fetchImpl = fetch } = {}) {
  const params = new URLSearchParams({
    outFields: 'PARCELID,OWNER,DEEDAC,ADDRESS,CMAP,PARCEL,COUNTY_NAME',
    returnGeometry: 'true', outSR: '4326', f: 'json',
  });
  if (q.at) {
    // whatever parcel contains this point — how you ask when all you have is a pin
    params.set('geometry', `${q.at[1]},${q.at[0]}`);
    params.set('geometryType', 'esriGeometryPoint');
    params.set('inSR', '4326');
    params.set('spatialRel', 'esriSpatialRelIntersects');
    params.set('where', '1=1');
  } else {
    const where = [
      q.county ? `COUNTY_NAME='${String(q.county).toUpperCase()}'` : null,
      q.map ? `CMAP='${q.map}'` : null,
      q.parcel ? `PARCEL='${q.parcel}'` : null,
    ].filter(Boolean).join(' AND ');
    if (!where) throw new Error('a parcel needs a county and number, or a point');
    params.set('where', where);
  }

  const res = await fetchImpl(`${TN}?${params}`);
  if (!res.ok) throw new Error(`the parcel service answered ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'the parcel service refused that query');
  const f = data.features?.[0];
  if (!f) throw new Error('no parcel there');

  const ring = f.geometry.rings[0].map(([lon, lat]) => [lat, lon]);
  const centre = ringCentre(ring);
  const acres = ringAcres(ring, centre);
  return {
    ring, centre, acres,
    attrs: f.attributes,
    rings: f.geometry.rings.length,
    // The deed and the drawn boundary are two accounts of one thing and they do
    // not agree exactly — they never do. Say by how much rather than choosing.
    deedAcres: f.attributes.DEEDAC ?? null,
    disagreement: f.attributes.DEEDAC
      ? +(((acres - f.attributes.DEEDAC) / f.attributes.DEEDAC) * 100).toFixed(1)
      : null,
  };
}

function ringCentre(ring) {
  const lat = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const lon = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  return [lat, lon];
}

function ringAcres(ring, centre) {
  const mLat = 111320, mLon = 111320 * Math.cos((centre[0] * Math.PI) / 180);
  const xs = ring.map((p) => (p[1] - centre[1]) * mLon);
  const ys = ring.map((p) => (p[0] - centre[0]) * mLat);
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    a += xs[i] * ys[j] - xs[j] * ys[i];
  }
  return Math.abs(a / 2) / 4046.8564224;
}

/**
 * Put the parcel into a place, in the place's own metres.
 *
 * Marked IMPORTED and carrying its own provenance, because a boundary is
 * somebody's official claim about the world and CREO must never present it as
 * its own. The 1.2% by which the drawn ring differs from the deed is recorded
 * on the entity: a surveyor's answer is not the assessor's, and a tool that
 * hides that is lying about how much it knows.
 */
export function addParcel(world, found, projection) {
  const footprint = found.ring.map(([lat, lon]) => projection.toLocal(lat, lon).map((v) => +v.toFixed(2)));
  const a = found.attrs;
  const id = `parcel-${String(a.PARCELID || 'unknown').trim().replace(/\s+/g, '-')}`;
  const z = world.place.groundAt(...centroidOf(footprint));
  world.place.put({
    id,
    type: 'parcel',
    name: `${a.PARCEL || 'parcel'} · ${a.ADDRESS || ''}`.trim(),
    footprint,
    zBase: z - 0.05,
    zTop: z,
    epistemic: 'IMPORTED',
    collision: 'none',
    use: 'boundary',
    provenance: {
      author: a.OWNER || 'unknown',
      how: 'boundary published by the Tennessee property viewer',
      when: new Date().toISOString(),
    },
    props: {
      parcelId: a.PARCELID,
      owner: a.OWNER,
      county: a.COUNTY_NAME,
      address: a.ADDRESS,
      deedAcres: found.deedAcres,
      drawnAcres: +found.acres.toFixed(2),
      // the two accounts, and their difference, kept rather than reconciled
      disagreementPercent: found.disagreement,
      note: 'the drawn boundary and the deed acreage are two accounts of one thing; '
        + 'neither is a survey, and where they differ CREO does not choose',
    },
  });
  return id;
}

const centroidOf = (ring) => [
  ring.reduce((s, p) => s + p[0], 0) / ring.length,
  ring.reduce((s, p) => s + p[1], 0) / ring.length,
];
