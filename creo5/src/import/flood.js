// THE FLOODPLAIN — the constraint that can make a beautiful site unbuildable.
//
// CREO has been able to say where a house sits most cheaply on this parcel for
// several days, and every one of those answers was unsafe, because the flattest
// ground on a river parcel is the terrace and the terrace is what floods. FEMA
// publishes the National Flood Hazard Layer openly. There is no excuse for a
// place model that knows the ground and not this.
//
// Zones, in the order they matter:
//   AE FLOODWAY  the channel that must carry the flood — building is prohibited
//   A / AE       the 1% annual chance floodplain — the "100-year" flood
//   X (0.2%)     the 0.2% annual chance — the "500-year" flood
//   X            minimal hazard

const NFHL = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query';

export const SEVERITY = { 'AE-FLOODWAY': 3, AE: 2, A: 2, 'X-0.2': 1, X: 0 };

export function classify(a) {
  const z = (a.FLD_ZONE || '').toUpperCase();
  const sub = (a.ZONE_SUBTY || '').toUpperCase();
  if (sub.includes('FLOODWAY')) return 'AE-FLOODWAY';
  if (z === 'A' || z === 'AE' || z === 'AO' || z === 'AH') return z === 'A' ? 'A' : 'AE';
  if (sub.includes('0.2')) return 'X-0.2';
  return 'X';
}

export async function findFlood(bbox, { fetchImpl = fetch } = {}) {
  const params = new URLSearchParams({
    geometry: `${bbox[1]},${bbox[0]},${bbox[3]},${bbox[2]}`,
    geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'FLD_ZONE,ZONE_SUBTY,STATIC_BFE', returnGeometry: 'true', f: 'json',
  });
  const res = await fetchImpl(`${NFHL}?${params}`);
  if (!res.ok) throw new Error(`FEMA answered ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'FEMA refused that query');
  return (data.features || []).map((f) => ({
    zone: classify(f.attributes),
    bfe: Number.isFinite(f.attributes.STATIC_BFE) && f.attributes.STATIC_BFE > -9999
      ? f.attributes.STATIC_BFE : null,
    rings: (f.geometry.rings || []).map((r) => r.map(([lon, lat]) => [lat, lon])),
  })).filter((z) => z.rings.length);
}

/** Put the flood zones into a place, in its own metres. */
export function addFlood(world, zones, projection) {
  const ids = [];
  for (const [n, z] of zones.entries()) {
    for (const [m, ring] of z.rings.entries()) {
      const footprint = ring.map(([lat, lon]) => projection.toLocal(lat, lon).map((v) => +v.toFixed(2)));
      if (footprint.length < 3) continue;
      const id = `flood-${z.zone.toLowerCase()}-${n}-${m}`;
      const c = footprint.reduce((s, p) => [s[0] + p[0] / footprint.length, s[1] + p[1] / footprint.length], [0, 0]);
      const g = world.place.groundAt(c[0], c[1]);
      world.place.put({
        id, type: 'region', name: `FEMA ${z.zone}`,
        footprint, zBase: g - 0.02, zTop: g,
        epistemic: 'IMPORTED', collision: 'none', use: 'flood',
        provenance: { author: 'FEMA', how: 'National Flood Hazard Layer', when: new Date().toISOString() },
        props: { zone: z.zone, severity: SEVERITY[z.zone], baseFloodElevation_ft: z.bfe,
          note: z.zone === 'AE-FLOODWAY' ? 'floodway — building is prohibited here'
            : SEVERITY[z.zone] === 2 ? 'the 1% annual chance floodplain' : null },
      });
      ids.push(id);
    }
  }
  return ids;
}
