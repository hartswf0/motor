// HENRY HOUSE — STRUCTURAL MODEL.
//
// This replaces the prose-and-placeholder block that used to live in
// geometry.mjs. Members here are SIZED, not asserted: each one is derived from
// a tributary width, a load combination, an allowable bending stress and a
// deflection limit, and the result is checked by tools/check/structure.mjs.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS IS NOT AN ENGINEERED DESIGN. It is a preliminary sizing pass whose only
// purpose is to make the package HONEST about member depths — so that the
// section, the 3D model and the cost conversation are not built on a number
// that was invented. A licensed structural engineer must redo all of it.
//
// The load that governs everything here — GROUND SNOW — is UNVERIFIED. Watauga
// County is frequently a case-study ("CS") snow area, meaning no map value
// exists and the AHJ or a registered engineer sets it for the site elevation.
// Change SNOW_GROUND below and every member in this file resizes.
// ─────────────────────────────────────────────────────────────────────────────

import { ft } from './units.mjs';

// ── LOADS (psf) ─────────────────────────────────────────────────────────────
export const LOADS = {
  // ASSUMED. See docs/02-code-basis.md §D — none of these was verified.
  SNOW_GROUND: { v: 50, unit: 'psf', status: 'UNVERIFIED — Watauga may be a case-study snow area; this is a placeholder' },
  SNOW_FACTOR: { v: 0.7, unit: '—', status: 'Cs·Ce·Ct·I product, ASSUMED; drift NOT considered' },
  ROOF_DEAD:   { v: 20, unit: 'psf', status: 'standing seam + 16" I-joist + R-60 dense-pack + gwb' },
  FLOOR_DEAD:  { v: 22, unit: 'psf', status: 'I-joist + 3/4" T&G + gypcrete at sleeping levels' },
  FLOOR_LIVE:  { v: 40, unit: 'psf', status: 'residential; 30 psf sleeping rooms not taken' },
  DECK_LIVE:   { v: 60, unit: 'psf', status: 'exterior deck' },
  WALL_DEAD:   { v: 15, unit: 'psf', status: '2x6 + mineral wool + rainscreen + siding' },
  SOIL_EFP:    { v: 45, unit: 'pcf', status: 'equivalent fluid pressure, ASSUMED — geotech must set this' },
  SOIL_BEARING:{ v: 2000, unit: 'psf', status: 'ASSUMED. Colluvial slopes frequently give far less.' },
};

export const roofSnow = () => LOADS.SNOW_GROUND.v * LOADS.SNOW_FACTOR.v;   // psf

// ── MATERIALS ───────────────────────────────────────────────────────────────
export const MATERIALS = {
  glulam24F: { name: '24F-1.8E glulam', Fb: 2400, E: 1.8e6, Fv: 265, widths: [3.125, 5.125, 6.75, 8.75] },
  psl2900:   { name: '2.0E PSL',        Fb: 2900, E: 2.0e6, Fv: 290, widths: [3.5, 5.25, 7] },
  sawnNo2:   { name: 'No.2 SPF',        Fb: 875,  E: 1.4e6, Fv: 135, widths: [1.5, 3, 4.5] },
};

/** Glulam depths come in 1-1/2" laminations. */
const GLULAM_DEPTHS = Array.from({ length: 20 }, (_, i) => 7.5 + i * 1.5);

const CD = 1.15;      // load duration, snow
const CM = 1.0;       // dry service

/**
 * Size a simply-supported bending member.
 * Returns the shallowest available depth satisfying BOTH bending and deflection.
 */
export function sizeBeam({ spanFt, tribFt, loadPsf, mat = MATERIALS.glulam24F, width = 5.125,
                           deflLimit = 240, liveFraction = 0.6, label = '' }) {
  const L = spanFt * 12;                       // in
  const w = (loadPsf * tribFt) / 12;           // lb per inch
  const M = (w * L * L) / 8;                   // lb-in
  const Fb = mat.Fb * CD * CM;
  const Sreq = M / Fb;

  const wLive = w * liveFraction;
  const dAllow = L / deflLimit;

  for (const d of GLULAM_DEPTHS) {
    const S = (width * d * d) / 6;
    const I = (width * d * d * d) / 12;
    const defl = (5 * wLive * Math.pow(L, 4)) / (384 * mat.E * I);
    const V = (w * L) / 2;
    const fv = (1.5 * V) / (width * d);
    if (S >= Sreq && defl <= dAllow && fv <= mat.Fv * CD) {
      return {
        label, spanFt, tribFt, loadPsf, width, depth: d,
        section: `${width} x ${d}`, material: mat.name,
        Sreq: +Sreq.toFixed(0), Sprov: +S.toFixed(0),
        deflIn: +defl.toFixed(2), deflAllowIn: +dAllow.toFixed(2),
        governs: defl > dAllow * 0.95 ? 'deflection' : 'bending',
        reactionLb: +((w * L) / 2).toFixed(0),
        ok: true,
      };
    }
  }
  return { label, spanFt, tribFt, loadPsf, ok: false, note: 'no available depth satisfies this span — change the structure, not the member' };
}

// ── THE RIBS ────────────────────────────────────────────────────────────────
// 26 ft clear, 12 ft on centre. These carry the roof AND, at bays E-G, the
// upper floor. The old placeholder was 5-1/8 x 15, which this pass shows was
// badly undersized: deflection governs, not bending.
const ROOF_TOTAL = LOADS.ROOF_DEAD.v + roofSnow();
const FLOOR_TOTAL = LOADS.FLOOR_DEAD.v + LOADS.FLOOR_LIVE.v;

export const RIB_ROOF = sizeBeam({
  spanFt: 26, tribFt: 12, loadPsf: ROOF_TOTAL, width: 5.125,
  label: 'RIB — roof only (bays A–D)', liveFraction: roofSnow() / ROOF_TOTAL,
});

export const RIB_ROOF_FLOOR = sizeBeam({
  spanFt: 26, tribFt: 12, loadPsf: ROOF_TOTAL + FLOOR_TOTAL, width: 6.75,
  label: 'RIB — roof + upper floor (bays E–G)',
  liveFraction: (roofSnow() + LOADS.FLOOR_LIVE.v) / (ROOF_TOTAL + FLOOR_TOTAL),
});

// ── FLOOR FRAMING ───────────────────────────────────────────────────────────
export const FLOOR_JOIST = {
  label: 'FLOOR — 11-7/8" I-joist @ 16" o.c.',
  spanFt: 13, note: 'spans grid 1 to grid 2 and grid 2 to grid 3, both under 15 ft',
  loadPsf: FLOOR_TOTAL, deflLimit: 'L/480 for gypcrete levels',
  status: 'SPAN IS WITHIN ORDINARY I-JOIST TABLES — but the table has not been consulted',
};

// ── THE DECK ────────────────────────────────────────────────────────────────
// 12 ft deep: 4 ft cantilever past the downhill column line, 8 ft back-span.
export const DECK_BEAM = sizeBeam({
  spanFt: 12, tribFt: 12, loadPsf: LOADS.FLOOR_DEAD.v + LOADS.DECK_LIVE.v,
  width: 5.125, deflLimit: 360, liveFraction: LOADS.DECK_LIVE.v / (LOADS.FLOOR_DEAD.v + LOADS.DECK_LIVE.v),
  label: 'DECK BEAM — outer post line',
});

// ── COLUMNS AND FOOTINGS ────────────────────────────────────────────────────
/** Column load = rib reaction, accumulated down the storeys it supports. */
export function columnLoad(storeys = 1) {
  const perRib = RIB_ROOF.reactionLb ?? 0;
  return Math.round(perRib * storeys);
}

export function footingFor(loadLb, bearingPsf = LOADS.SOIL_BEARING.v) {
  const areaSf = loadLb / bearingPsf;
  const side = Math.sqrt(areaSf);
  const sizeIn = Math.ceil((side * 12) / 6) * 6;      // round up to 6"
  return { loadLb, areaSf: +areaSf.toFixed(1), sizeIn, size: `${sizeIn}" x ${sizeIn}"`,
           note: 'bearing value ASSUMED — a geotechnical report governs' };
}

export const COLUMN_DOWNHILL = {
  label: 'DOWNHILL COLUMN — grid 1',
  member: 'HSS 6x6x1/4 (preliminary)',
  loadLb: columnLoad(2),
  footing: footingFor(columnLoad(2)),
  note: 'Carries roof + main level at bays A–D. Continuous to a pier on competent material — depth NOT ASSUMED.',
};

// ── THE SPINE WALL ──────────────────────────────────────────────────────────
// A cantilever retaining wall with an axial load on top: it takes the uphill
// end of every rib AND holds the cut.
export function retainingWall({ retainedFt, efp = LOADS.SOIL_EFP.v, surchargePsf = 0 }) {
  const H = retainedFt;
  const P = 0.5 * efp * H * H + surchargePsf * H;      // lb per foot of wall
  const arm = H / 3;
  const M = P * arm;                                    // lb-ft per foot
  // Stem thickness from flexure, f'c = 3000, fy = 60000, rho ~ 0.0033 -> Rn ~ 190 psi.
  //   Mu = 1.6 * M_service ;  d = sqrt(Mu / (phi * Rn * b))
  // The first version of this used an invented formula and returned 30" and 54"
  // walls, which is why it is written out longhand now.
  const Mu = 1.6 * M * 12;                       // lb-in per foot of wall
  const Rn = 190, phi = 0.9, b = 12;
  const d = Math.sqrt(Mu / (phi * Rn * b));
  const t = Math.max(10, Math.ceil((d + 2.5) / 2) * 2);   // + cover, round to 2"
  return {
    retainedFt: H, lateralLbPerFt: Math.round(P), momentLbFtPerFt: Math.round(M),
    thicknessIn: t, effectiveDepthIn: +d.toFixed(1), footingWidthFt: +(H * 0.65).toFixed(1),
    note: 'PRELIMINARY. Reinforcement, heel/toe geometry, sliding, overturning, bearing and global stability must all be designed by a licensed engineer on geotechnical recommendations.',
  };
}

export const SPINE_WALL = retainingWall({ retainedFt: 7.4 });

// The court cut is 16.4 ft at its deepest — model/site.mjs earthwork(), not a
// recollection. The design lays that face back at 1.5H:1V instead of retaining
// it, which is why no wall this tall appears in the drawings. This member is
// the ALTERNATIVE: what it costs if the geotechnical report says the slope will
// not stand. A 16 ft cantilever wall with vehicle surcharge is a different
// project, and that is exactly why the number is written down.
export const COURT_WALL = retainingWall({ retainedFt: 16.4, surchargePsf: 100 });
COURT_WALL.role = 'ALTERNATIVE TO THE LAID-BACK CUT — see C-101 note 5';

// ── LATERAL ─────────────────────────────────────────────────────────────────
export const LATERAL = {
  concept: 'Concrete spine takes the uphill shear; continuous rod hold-down shear panels at grids A, C, E and G take the downhill side; roof and floor diaphragms transfer between them.',
  problem: 'The downhill wall is almost entirely glass. Prescriptive wall bracing under the NC amended R602.10 will NOT work here.',
  requires: 'ENGINEERED lateral design. Seismic Design Category, design wind speed, exposure category and topographic factor Kzt are all UNVERIFIED — see docs/02-code-basis.md §D.',
};

export const MEMBERS = [RIB_ROOF, RIB_ROOF_FLOOR, DECK_BEAM];

export default {
  LOADS, MATERIALS, roofSnow, sizeBeam, RIB_ROOF, RIB_ROOF_FLOOR, FLOOR_JOIST,
  DECK_BEAM, COLUMN_DOWNHILL, SPINE_WALL, COURT_WALL, LATERAL, MEMBERS,
  columnLoad, footingFor, retainingWall,
};
