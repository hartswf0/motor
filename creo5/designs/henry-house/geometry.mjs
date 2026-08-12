// HENRY HOUSE — GEOMETRY: the single source of truth.
//
// Every plan, section, elevation, roof plan, systems diagram and 3D render in
// this package is generated from this file. If two drawings disagree, it is a
// bug in a generator, not a coordination error in the design.
//
// ─────────────────────────────────────────────────────────────────────────────
// COORDINATE SYSTEM
//   X  runs along the long axis of the house.  X=0 at the WEST end, +X EAST.
//      The long axis bears N70°E, chosen to lie along the assumed contour.
//   Y  runs across the house.  Y=0 at the DOWNHILL (view) face, +Y UPHILL.
//      The downhill face therefore looks toward azimuth 160° (SSE).
//   Z  is inches above PROJECT DATUM.  Z=0 = LOWER LEVEL finished floor
//      = assumed EL. 100'-0" on the project datum (see units.mjs).
//
//   So: -Y = downhill / view / sun.   +Y = uphill / cut / cold.
//       -X = down the length of the hill (grade falls 8% toward the west).
//
// ALL SITE ELEVATIONS ARE ASSUMED PENDING SURVEY. See docs/01-site-facts-register.md.
// ─────────────────────────────────────────────────────────────────────────────

import { ft, rect, polyArea, sf } from './units.mjs';
import { SITE_CONTEXT } from './site-context.mjs';
import { RIB_ROOF, RIB_ROOF_FLOOR } from './structure.mjs';

// ── THE PARCEL ───────────────────────────────────────────────────────────────
/**
 * The client gave a coordinate. Until then this project had four known facts
 * and no ground; everything about the hill was assumed. See K-5 in
 * docs/01-site-facts-register.md.
 *
 * The terrain below is MEASURED, not assumed — but measured at 31 m, which is
 * the resolution of a public DEM and not a survey. It settles which way the
 * hill faces and roughly how steep it is. It does not settle where the bench
 * is, where the rock is, or where a house can actually stand.
 */
export const SITE = {
  // ONE coordinate, from the parcel record in model/site-context.mjs. This file
  // briefly carried its own — copied out of CREO, which had parsed the seconds
  // as 14.16" rather than 14.2" and landed 1.2 m away. Two declarations of one
  // number is the fault this project keeps finding in itself; 1.2 m does not
  // matter and a second source does.
  get lat() { return SITE_CONTEXT.anchor.lat; },     // 36°17'14.2"N
  get lon() { return SITE_CONTEXT.anchor.lon; },     // 81°55'30.4"W
  source: 'Client, 2026-08-11 — parcel record TN-JOHNSON-100-064.03',
  // ── the jurisdiction, which is NOT the one on the drawings ───────────────
  // Every title block in this set says WATAUGA COUNTY, NORTH CAROLINA. The
  // parcel record says Johnson County, TENNESSEE. A North Carolina statute has
  // no force in Tennessee, so this is not a caption error: it changes the code
  // basis, the permitting authority, and whether the NC Mountain Ridge
  // Protection Act assumed at docs/01 A-06 applies at all.
  county: 'JOHNSON', state: 'TN',
  parcelId: '100 064.03',
  deedAcres: 29.34,
  // ── measured off the DEM at that coordinate ──────────────────────────────
  elevationFtAmsl: 2364,      // 720.5 m — NOT the 3,412 ft this project assumed
  fallsToAzimuth: 5,          // degrees from true north: the land falls NORTH
  crossSlopePctMeasured: 30,  // at a ±92 m window; 40% at ±31 m, 27% at ±185 m
  terrain: 'terrarium z12 (~31 m/px), AWS open data, via CREO (hartswf0/motor)',
  corroboration: 'The Watauga River is mapped 298 m NORTH of the anchor. Rivers ' +
                 'sit in valleys, so an independent source agrees the fall is north.',
  note: 'MEASURED at 31 m. Confirm by survey before anything is priced or dug.',
};

// ── Orientation ──────────────────────────────────────────────────────────────
/**
 * ⚠ CONTRADICTED BY THE SITE. Left standing deliberately, and not rotated.
 *
 * This project assumed the downhill face — the glass, the view, the winter sun,
 * the whole parti — looked SSE at azimuth 160°. At the coordinate the client
 * gave, the land falls almost due NORTH (354°–34° depending on the window, 5°
 * at building scale). The assumed view face points INTO the hill.
 *
 * docs/01 wrote this project's own alarm for exactly this case, at A-03:
 *
 *   "If the real view is north or the slope faces north, the plan must be
 *    RECONSIDERED, NOT ROTATED."
 *
 * So these numbers are NOT quietly re-pointed. Spinning the azimuth would make
 * every drawing self-consistent and every drawing wrong: on a north slope the
 * view and the winter sun are on OPPOSITE faces, and no rotation reconciles
 * them. That is a design decision about what this house is, not a constant.
 */
export const ORIENTATION = {
  longAxisAzimuth: 70,        // +X direction, degrees from true north
  viewFaceAzimuth: 160,       // -Y face normal (SSE) — glass wall + terrace
  uphillFaceAzimuth: 340,     // +Y face normal (NNW) — cut, motor court, service
  status: 'CONTRADICTED by SITE.fallsToAzimuth — see docs/01 A-03 and docs/09',
  note: 'ASSUMED. Must be reset from survey + a real solar/view study on the parcel.',
};

// ── Assumed site plane (see site.mjs for the full terrain model) ────────────
export const SITE_SLOPE = {
  crossSlopePct: 30,          // falls 30% in the -Y direction (downhill, SSE)
  longSlopePct: 8,            // falls 8% in the -X direction (toward the west)
  gradeAtOrigin: -6,          // inches: natural grade at (x=0, y=0)
  /** Assumed natural (pre-construction) grade, inches above datum. */
  grade(x, y) {
    return this.gradeAtOrigin + (this.crossSlopePct / 100) * y + (this.longSlopePct / 100) * x;
  },
};

// ── Structural grid ──────────────────────────────────────────────────────────
// Transverse frames ("ribs") at 12'-0" o.c. — the ribcage off the spine.
export const GRID = {
  x: [
    { id: 'A', v: ft(0) },
    { id: 'B', v: ft(12) },
    { id: 'C', v: ft(24) },
    { id: 'D', v: ft(36) },
    { id: 'E', v: ft(48) },
    { id: 'F', v: ft(60) },
    { id: 'G', v: ft(72) },
  ],
  y: [
    { id: '1', v: ft(0) },    // downhill face — the glass line
    { id: '2', v: ft(15) },   // the SPINE LINE: living zone / service zone divider
    { id: '3', v: ft(26) },   // uphill face — the service wall
  ],
  bay: ft(12),
};

export const BAR = {
  x0: ft(0), x1: ft(72),      // 72'-0" long
  y0: ft(0), y1: ft(26),      // 26'-0" deep
  extWall: 10,                // 2x6 stud + sheathing + 2" mineral wool + rainscreen + siding
  partition: 5,               // 2x4 + gwb both faces
  wetPartition: 7,            // 2x6 plumbing wall
};

// ── Levels ───────────────────────────────────────────────────────────────────
// Floor-to-floor 120" (10'-0") lower->main; 120" main->upper.
export const LEVELS = [
  { id: 'L0', name: 'LOWER LEVEL',  ffe: ft(0),  clear: 107, floorAssembly: 13, short: 'LOWER' },
  { id: 'L1', name: 'MAIN LEVEL',   ffe: ft(10), clear: 107, floorAssembly: 13, short: 'MAIN'  },
  { id: 'L2', name: 'UPPER LEVEL',  ffe: ft(20), clear: 103, floorAssembly: 13, short: 'UPPER' },
];
export const levelById = (id) => LEVELS.find(l => l.id === id);

// ── Building footprints per level (out-to-out of the enclosing wall) ────────
export const FOOTPRINTS = {
  // Lower level: bays A–C only. Walks out to the SSE where grade has fallen 10'.
  L0: { x0: ft(0),  x1: ft(36), y0: ft(0), y1: ft(26) },
  // Main level: the full bar A–G, plus the LINK (mudroom) reaching east to the garage.
  L1: { x0: ft(0),  x1: ft(72), y0: ft(0), y1: ft(26) },
  // Upper level: bays E–G only — the two-storey "tall wing" at the uphill/east end.
  L2: { x0: ft(48), x1: ft(72), y0: ft(0), y1: ft(26) },
};

// Sealed, conditioned crawlspace under bays D–G (grade rises to the east).
export const CRAWL = { x0: ft(36), x1: ft(72), y0: ft(0), y1: ft(26), clear: 54, ffe: ft(0) + 6 };

// ── The LINK (mudroom / airlock) and the GARAGE ──────────────────────────────
// The garage is a SEPARATE structure joined by a low conditioned link. Detaching
// it removes every garage→house CO and fire-separation problem at the source,
// and it lets the garage sit at motor-court level while the house steps down.
export const LINK = {
  x0: ft(72), x1: ft(87),      // 15'-0" long
  y0: ft(5),  y1: ft(26),      // 21'-0" deep
  ffe: ft(10),                 // matches MAIN
  roofTop: ft(10) + 132,       // low flat/1:12 roof, top of deck
  extWall: 10,
};

export const GARAGE = {
  x0: ft(96), x1: ft(120),     // 24'-0"
  y0: ft(5),  y1: ft(29),      // 24'-0"
  ffe: ft(10) - 8,             // 8" below MAIN — slab drains away from the link door
  clear: 120,
  ridgeTop: ft(10) - 8 + 196,
  extWall: 10,
  // The gap to the LINK was 2'-0", which is a joint, not a breezeway. It is now
  // 9'-0" and roofed: you get out of the car under cover, and the fire gap and
  // the CO separation are both real.
  breezeway: { x0: ft(87), x1: ft(96), width: ft(9), covered: true },
  note: 'Detached, joined by a 9\'-0" covered breezeway to the LINK. 2 bays + shop.',
};

// ── MASONRY MASS ─────────────────────────────────────────────────────────────
//
// It existed in the 3D model and nowhere else.
//
// The render carried a hardcoded stone chimney at a position no plan, section,
// elevation, schedule or check knew about — while the plans carried a WOOD
// STOVE fixture 3'-0" away from it. Two representations of the same object,
// disagreeing, in a package whose whole argument is that this cannot happen.
//
// It is now declared once, here, and the checker asserts the stove fixture sits
// inside it. Move either and the build fails.
//
// WHY IT IS WORTH KEEPING: it is the only heat source in the house that needs
// no electricity, no fuel delivery and no controller. In VSM terms it is S1
// SHELTER's fallback when POWER and its whole supply chain are gone — the one
// piece of the design that still works after every anticipatory policy on
// G-001 has run out of things to anticipate with.
export const MASONRY = {
  id: 'MSNRY-1', name: 'MASONRY MASS + FLUE',
  x0: 280, x1: 336,            // 4'-8" wide, aligned on the wood stove
  y0: 96,  y1: 152,            // 4'-8" deep
  zBot: -30,                   // footing below the lower slab — it is a load, not a finish
  capAboveRoof: 96,            // 8'-0" of flue above the roof plane it passes through
  flue: { x: 308, y: 124, dia: 16 },
  hearthFront: 16,             // ASSUMED hearth extension in front of the appliance
  clearToCombustible: 36,      // ASSUMED. Listed appliance clearances govern, not this file.
  serves: 'FF-110 WOOD STOVE, great room',
  // It straddles the Gallery / great room line on purpose: the mass radiates
  // into both, and the Gallery is the acoustic and thermal buffer in front of
  // the primary suite. Heat arriving there on a night with no power is heat
  // arriving where somebody is trying to sleep.
  position: 'built into the partition between THE GALLERY and the GREAT ROOM',
  status: 'CLEARANCES AND HEARTH EXTENSION ARE ASSUMED — the appliance listing and the governing code set them. Chimney height above the roof and to nearby ridges is NOT verified.',
};

// ── ROOMS ────────────────────────────────────────────────────────────────────
// Rectangles are INSIDE FACE OF FINISH. [x, y, w, h] in inches.
const R = (id, name, x, y, w, h, opts = {}) => ({
  id, name, x, y, w, h,
  poly: rect(x, y, w, h),
  areaSqIn: w * h,
  area: sf(w * h),
  zone: y >= ft(15) ? 'spine' : 'living',
  ...opts,
});

export const ROOMS = {
  L0: [
    // Rooms swapped end for end. The stair used to land INSIDE the guest
    // bedroom, and the mechanical room's door opened into it too. Now the
    // stair and The Heart both open onto the family room, and BATH 3 becomes
    // the guest ensuite.
    R('L0-guest',   'GUEST BEDROOM',      10,  10, 150, 170, { use: 'sleeping', egress: true }),
    R('L0-family',  'FAMILY / FLEX',     165,  10, 260, 170, { use: 'living',  finish: 'engineered wood' }),
    R('L0-bath3',   'BATH 3',             10, 185, 140, 117, { use: 'wet', note: 'guest ensuite' }),
    R('L0-heart',   'MECHANICAL — "THE HEART"', 155, 185, 128, 117, { use: 'mech', critical: true }),
    R('L0-stairD',  'STAIR — LOWER',     288, 185, 134, 117, { use: 'circ', stair: 'S2' }),
  ],
  L1: [
    R('L1-primary', 'PRIMARY BEDROOM',    10,  10, 190, 170, { use: 'sleeping', egress: true }),
    R('L1-pbath',   'PRIMARY BATH',       10, 185, 130, 117, { use: 'wet' }),
    R('L1-pcloset', 'W.I. CLOSET',       145, 185,  55, 117, { use: 'storage' }),
    R('L1-gallery', 'THE GALLERY',       205,  10,  78, 292, { use: 'circ', note: 'acoustic + thermal buffer between the public house and the primary suite; carries the vertical chase' }),
    R('L1-great',   'GREAT ROOM',        288,  10, 288, 170, { use: 'living', tallCeiling: true }),
    R('L1-stairD',  'STAIR — DOWN',      288, 185, 134, 117, { use: 'circ', stair: 'S2' }),
    R('L1-office',  'OFFICE / STUDY',    427, 185, 144, 117, { use: 'work', acoustic: true }),
    R('L1-dining',  'DINING',            581,  10, 149, 170, { use: 'living' }),
    R('L1-kitchen', 'KITCHEN',           735,  10, 119, 170, { use: 'wet' }),
    R('L1-stairU',  'STAIR — UP',        581, 185, 119, 117, { use: 'circ', stair: 'S1' }),
    R('L1-entry',   'ENTRY',             705, 185,  85, 117, { use: 'circ', note: 'guest arrival from the motor court, via the entry bridge' }),
    R('L1-pantry',  'PANTRY',            795, 185,  59, 117, { use: 'storage' }),
    // LINK
    R('LK-mud',     'MUDROOM / AIRLOCK', ft(72) + 10, ft(5) + 10, 160, 130, { use: 'circ', link: true, note: 'the checkpoint: boots, coats, scrub sink, dog wash' }),
    R('LK-laundry', 'LAUNDRY',           ft(72) + 10, ft(5) + 145, 100,  97, { use: 'wet', link: true }),
    R('LK-powder',  'POWDER',            ft(72) + 115, ft(5) + 145, 55,  97, { use: 'wet', link: true }),
  ],
  L2: [
    R('L2-bed2',    'BEDROOM 2',         581,  10, 139, 170, { use: 'sleeping', egress: true }),
    R('L2-bed3',    'BEDROOM 3',         725,  10, 129, 170, { use: 'sleeping', egress: true }),
    R('L2-stairU',  'STAIR',             581, 185, 119, 117, { use: 'circ', stair: 'S1' }),
    // A corridor east of the stair. Without it BEDROOM 3 could only be entered
    // through BATH 2 — caught by tools/check/clash.mjs, not by looking.
    R('L2-hall',    'HALL',              705, 185, 149,  36, { use: 'circ' }),
    R('L2-bath2',   'BATH 2',            705, 226, 105,  76, { use: 'wet' }),
    R('L2-linen',   'LINEN / AIR HANDLER', 815, 226, 39, 76, { use: 'mech' }),
  ],
};

export const roomById = (id) => Object.values(ROOMS).flat().find(r => r.id === id);

// ── STAIRS ───────────────────────────────────────────────────────────────────
// Both are U-stairs (two runs + a mid landing) so a 10'-0" rise fits inside the
// 9'-9" deep service spine. Riser/tread verified against the code basis in
// tools/check/clash.mjs — do not change these numbers without re-running checks.
export const STAIRS = [
  {
    id: 'S1', name: 'MAIN STAIR', from: 'L1', to: 'L2',
    x: 581, y: 185, w: 119, d: 117,
    risers: 16, riserHeight: 7.5, treadDepth: 10.5, runsPerFlight: 8,
    clearWidth: 38, landingDepth: 44, headroom: 82,
    note: 'MAIN → UPPER. Guarded, 34–38" handrail both sides.',
  },
  {
    id: 'S2', name: 'LOWER STAIR', from: 'L0', to: 'L1',
    x: 288, y: 185, w: 134, d: 117,
    risers: 16, riserHeight: 7.5, treadDepth: 10.5, runsPerFlight: 8,
    clearWidth: 38, landingDepth: 44, headroom: 82,
    note: 'MAIN → LOWER. Separate from S1 so the guest level is not reached through the bedroom wing.',
  },
];

// ── ROOF ─────────────────────────────────────────────────────────────────────
// TWO shed planes, both 3:12, both falling toward the DOWNHILL (SSE) face.
//
// WHY THEY FALL DOWNHILL — this is the single most consequential roof decision:
//   1. No roof water is ever delivered to the uphill side, where the cut and the
//      groundwater problem already are. The uphill side stays dry.
//   2. The ceiling drops toward the view: compression at the glass, release at
//      the back. The tall side faces the cut, so the mass reads low from below.
//   3. Snow is shed to a DESIGNED apron on the downhill side, not onto the
//      entry, the motor court, or the mechanical equipment.
// Snow retention is required over every downhill door — see the snow plan sheet.
export const ROOF_ASSEMBLY = 20;   // in: I-joist + vent channel + sheathing + standing seam
export const ROOF_PITCH = 3;       // : 12

export const ROOFS = [
  {
    id: 'RA', name: 'ROOF A — LOW WING',
    x0: ft(0), x1: ft(48), y0: ft(0), y1: ft(26),
    pitch: 3, fallDir: '-Y',
    topAtY0: 258,            // top of deck at the downhill eave line
    get topAtY1() { return this.topAtY0 + (this.pitch / 12) * (this.y1 - this.y0); }, // 336
    overhang: { south: 48, north: 24, west: 24, east: 0 },
    covers: 'primary suite, gallery, great room, lower stair, office',
  },
  {
    id: 'RB', name: 'ROOF B — TALL WING',
    x0: ft(48), x1: ft(72), y0: ft(0), y1: ft(26),
    pitch: 3, fallDir: '-Y',
    topAtY0: 363,
    get topAtY1() { return this.topAtY0 + (this.pitch / 12) * (this.y1 - this.y0); }, // 441
    overhang: { south: 48, north: 24, west: 18, east: 24 },
    covers: 'dining, kitchen, main stair, entry, upper level bedrooms',
  },
  {
    id: 'RL', name: 'ROOF L — LINK',
    x0: LINK.x0, x1: LINK.x1, y0: LINK.y0, y1: LINK.y1,
    pitch: 1, fallDir: '-Y',
    topAtY0: ft(10) + 126,
    get topAtY1() { return this.topAtY0 + (this.pitch / 12) * (this.y1 - this.y0); },
    overhang: { south: 36, north: 24, west: 0, east: 0 },
    covers: 'mudroom / airlock link',
  },
  {
    id: 'RG', name: 'ROOF G — GARAGE',
    x0: GARAGE.x0, x1: GARAGE.x1, y0: GARAGE.y0, y1: GARAGE.y1,
    pitch: 4, fallDir: '-Y',
    topAtY0: GARAGE.ffe + 130,
    get topAtY1() { return this.topAtY0 + (this.pitch / 12) * (this.y1 - this.y0); },
    overhang: { south: 30, north: 24, west: 24, east: 24 },
    covers: 'garage / shop',
  },
];
export const roofById = (id) => ROOFS.find(r => r.id === id);

/** Top of roof deck at any (x,y). Returns null outside all roof planes. */
export function roofTopAt(x, y) {
  for (const r of ROOFS) {
    if (x >= r.x0 - r.overhang.west && x <= r.x1 + r.overhang.east &&
        y >= r.y0 - r.overhang.south && y <= r.y1 + r.overhang.north) {
      const yy = Math.max(r.y0, Math.min(r.y1 + r.overhang.north, y));
      return r.topAtY0 + (r.pitch / 12) * (yy - r.y0);
    }
  }
  return null;
}

/** Finished ceiling height (inches above datum) under a sloped roof at (x,y). */
export function ceilingAt(x, y) {
  const t = roofTopAt(x, y);
  return t === null ? null : t - ROOF_ASSEMBLY;
}

// ── THE CLERESTORY ───────────────────────────────────────────────────────────
// Roof B sits 105" above Roof A. The step at grid E is glazed: a raking,
// west-facing clerestory that washes the tall great room with late light and
// lets the volume dump heat high in summer. Exterior fins + low-SHGC glass.
export const CLERESTORY = {
  x: ft(48), y0: 10, y1: 180,
  zBotAtY0: 268, zTopAtY0: 343,     // between Roof A deck top and Roof B ceiling
  zBotAtY1: 268 + 42.5, zTopAtY1: 343 + 42.5,
  glassArea: sf((180 - 10) * 75),
  shading: 'exterior aluminum fin 18" deep at 24" o.c., vertical; glass SHGC ≤ 0.27',
  operable: 'two motorised awning units at the high end for summer stack venting',
};

// ── STRUCTURE ────────────────────────────────────────────────────────────────
// THE SKELETON. One spine, ribs off it, everything reaching ground.
//
//   SPINE   — a continuous reinforced concrete wall on grid line 3 (the uphill
//             wall). It retains the cut, carries the uphill end of every rib,
//             resists the lateral load, and is the thermal mass. One element,
//             four jobs. Everything downhill hangs off it.
//   RIBS    — transverse glulam frames at 12'-0" o.c. on the X grid, running
//             from the spine down to the downhill columns.
//   REACH   — every rib line terminates on a footing on competent material.
//             No rib is supported by another rib. No load takes a detour.
export const STRUCTURE = {
  spine: {
    line: 'grid 3', y: ft(26),
    x0: ft(0), x1: ft(72),
    material: 'cast-in-place reinforced concrete',
    thickness: 12,
    zBot: -36,               // top of footing
    zTopL0: ft(10),          // concrete to MAIN level at bays A–C (retaining)
    zTopEast: ft(10) + 8,    // stem wall + crawl at bays D–G
    footing: { w: 30, d: 12, zTop: -36 },
    drainage: '4" perforated pipe in washed stone, filter fabric, daylighted BOTH ends — never to a sump',
    waterproofing: 'fluid-applied membrane + drainage composite, full height of retained earth',
    engineerNote: 'RETAINING HEIGHT AND REINFORCEMENT TO BE DESIGNED BY A NC-LICENSED STRUCTURAL ENGINEER ON GEOTECHNICAL RECOMMENDATIONS. Values here are placeholders for coordination only.',
  },
  // Sections come from model/structure.mjs, where they are SIZED from a
  // tributary width, a load combination and a deflection limit — not asserted.
  // The string that used to sit here read "glulam 5-1/8 x 15 (placeholder)",
  // and the sizing pass showed that member was undersized. A placeholder that
  // travels into drawings stops being a placeholder.
  ribs: GRID.x.map(g => ({
    id: `RIB-${g.id}`, x: g.v,
    member: g.v >= ft(48)
      ? `${RIB_ROOF_FLOOR.section} ${RIB_ROOF_FLOOR.material} — roof + upper floor`
      : `${RIB_ROOF.section} ${RIB_ROOF.material} — roof only`,
    sizedBy: 'model/structure.mjs',
    from: { y: ft(26), support: 'spine wall' },
    to:   { y: ft(0),  support: 'downhill column line' },
  })),
  downhillColumns: {
    line: 'grid 1', y: ft(0),
    material: 'HSS 6x6 steel columns on concrete piers at bays A–D; bearing wall at bays E–G',
    pier: { dia: 24, embed: 'to competent material per geotech — depth NOT ASSUMED' },
  },
  floors: {
    L0: 'slab-on-grade, 5" reinforced, over 4" washed stone + 15 mil vapour retarder + R-10 sub-slab',
    L1: '11-7/8" I-joists @ 16" o.c. on the ribs; 3/4" T&G glued+screwed',
    L2: '11-7/8" I-joists @ 16" o.c.; 1-1/2" gypcrete over for acoustic mass under bedrooms',
    roof: '16" I-joist rafters @ 24" o.c. with a continuous 2" vent channel above the insulation',
  },
  lateral: {
    concept: 'Concrete spine takes the uphill-side shear. Downhill side uses continuous rod hold-down shear panels at bays A, C, E, G. Roof and floor diaphragms transfer between them.',
    seismic: 'SEE docs/02-code-basis.md — Watauga County sits near the Eastern Tennessee Seismic Zone. SDC to be confirmed by the engineer of record.',
    wind: 'Exposure category and topographic factor Kzt matter enormously on a knob or escarpment. To be set from the survey, not assumed.',
  },
  requiresSeal: true,
};

// ── DECKS AND TERRACES ───────────────────────────────────────────────────────
export const DECKS = [
  {
    id: 'D1', name: 'MAIN DECK', level: 'L1',
    x0: ft(24), x1: ft(72), y0: ft(-12), y1: ft(0),
    top: ft(10) - 8,
    structure: 'ribs cantilever 4\'-0"; outer 8\'-0" on HSS posts down to the lower terrace',
    guard: '42" cable-infill guard on steel posts, top rail at 42"',
    note: 'Set back from the roof drip line — see the snow-shed apron.',
  },
  {
    id: 'D2', name: 'LOWER TERRACE', level: 'L0',
    x0: ft(0), x1: ft(36), y0: ft(-16), y1: ft(0),
    top: -6,
    structure: 'stone-faced retained terrace; 4\'-10" wall at the outer edge; free-draining backfill',
  },
  {
    id: 'D3', name: 'ENTRY BRIDGE', level: 'L1',
    x0: ft(58), x1: ft(64), y0: ft(26), y1: ft(30),
    top: ft(10) - 4,
    structure: 'steel-framed bridge spanning the drain gap from the motor court to the entry',
    note: 'THE DRAIN GAP: the house never touches the cut face. A 4\'-0" open, gravel-bottomed, trench-drained margin runs the length of the uphill wall so groundwater and meltwater are intercepted and carried away instead of loading a habitable wall. You do not close a contaminated wound tight; you leave a drain.',
  },
];

// EXTERIOR STAIR — lower terrace up to the main deck.
// Without this the lower terrace is a dead end: a 9'-10" change of level with
// no way up except back through the house. On a house whose whole argument is
// that the hill gives you the lower level, that is a serious omission.
export const EXT_STAIR = {
  id: 'S3', name: 'TERRACE STAIR',
  // RUNS EAST-WEST, parallel to the house, in the open part of the terrace.
  //
  // The first version ran north toward the house and climbed straight into the
  // UNDERSIDE OF THE MAIN DECK: at y = -31" the stair was already above the
  // deck framing, so the last 2'-6" of the climb passed through the deck.
  // Running it in X instead puts the whole flight WEST of the deck's edge
  // (deck starts at grid C, x = 36'-0"), so it rises in open air and lands on
  // the deck's west corner. It is also clear of the walkout slider and of
  // W-002, the guest bedroom escape window.
  orientation: 'X',
  xBot: 123, xTop: 288,             // 13'-9" run, west (bottom) to east (top)
  y: -108, w: 48,                   // 4'-0" clear, held out in the terrace
  zBot: -6, zTop: ft(10) - 8,
  risers: 16, riserHeight: 7.375, treadDepth: 11,
  guard: '42" steel guard, cable infill, both sides; guard returned at the deck landing',
  note: 'Come out of the lower level, turn, and go up. Nothing overhead, nothing blocked.',
};

export const DRAIN_GAP = {
  y0: ft(26), y1: ft(30),      // 4'-0" wide, full length of the uphill wall
  x0: ft(0), x1: ft(72),
  invert: ft(10) - 30,
  fill: '#57 washed stone over filter fabric, 6" trench drain at the invert, 1% fall to the west',
  outlet: 'daylights at the west end of the house to the level spreader — see drainage',
};

// ── SNOW ─────────────────────────────────────────────────────────────────────
// Standing seam metal at 3:12 releases snow in slabs. Where it lands is a
// design decision, not an accident.
// COORDINATION NOTE — this block was rewritten after the main level plan was
// drawn and looked at. The first version sent shed snow to a cobble apron at
// y = -6'-0" to -0'-0". But the MAIN DECK occupies y = -12'-0" to 0'-0". The
// apron was underneath the deck: the roof would have shed snow onto the deck
// and against the glass doors. A 4'-0" overhang cannot throw snow past a
// 12'-0" deck, so "shed it clear" is not available here.
//
// The resolution is the one real mountain buildings use: RETAIN the snow on the
// roof wherever an occupied surface is below, and let it melt off. Free
// shedding is only allowed where nothing is underneath.
export const SNOW = {
  shedDirection: '-Y (downhill / SSE)',
  slideZoneFactor: 1.5,        // × overhang projection, measured from the drip line
  strategy: 'RETAIN over occupied surfaces; SHED only where nothing is below.',
  retentionZones: [
    { roof: 'RA', x0: ft(24), x1: ft(48), reason: 'MAIN DECK below — continuous two-pipe snow fence at the eave, second row upslope' },
    { roof: 'RB', x0: ft(48), x1: ft(72), reason: 'MAIN DECK and dining/kitchen doors below' },
    { roof: 'RL', x0: LINK.x0, x1: LINK.x1, reason: 'discharges directly at the everyday entry and the breezeway' },
    { roof: 'RG', x0: GARAGE.x0, x1: GARAGE.x1, reason: 'garage doors and the motor court apron below' },
  ],
  freeShedZones: [
    { roof: 'RA', x0: ft(0), x1: ft(24), reason: 'no deck west of grid C — sheds to the cobble apron below' },
  ],
  apron: {
    y0: ft(-6), y1: ft(0), x0: ft(0), x1: ft(24),
    material: '18-24" river cobble over filter fabric and a drainage trench',
    note: 'Applies ONLY at bays A–C, west of the main deck, and along the lower terrace edge.',
  },
  prohibited: 'No mechanical equipment, meter, vent terminal, condenser, hose bib or walking surface within a free-shed slide zone.',
  verifyWithEngineer: 'Snow retention must be sized for the governing ground snow load, which is UNVERIFIED — Watauga County may be a case-study ("CS") snow area requiring an AHJ-set value. See docs/02-code-basis.md.',
};

// ── DERIVED SUMMARIES ────────────────────────────────────────────────────────
export function areaSummary() {
  const out = {};
  let heated = 0;
  for (const l of LEVELS) {
    const fp = FOOTPRINTS[l.id];
    const gross = sf((fp.x1 - fp.x0) * (fp.y1 - fp.y0));
    const net = ROOMS[l.id].filter(r => !r.link).reduce((a, r) => a + r.area, 0);
    out[l.id] = { name: l.name, gross, net };
    heated += gross;
  }
  const linkGross = sf((LINK.x1 - LINK.x0) * (LINK.y1 - LINK.y0));
  out.LINK = { name: 'LINK / MUDROOM', gross: linkGross, net: ROOMS.L1.filter(r => r.link).reduce((a, r) => a + r.area, 0) };
  heated += linkGross;
  out.GARAGE = { name: 'GARAGE (unheated)', gross: sf((GARAGE.x1 - GARAGE.x0) * (GARAGE.y1 - GARAGE.y0)), net: 0 };
  out.TOTAL_HEATED_GROSS = heated;
  return out;
}

export const PROGRAM_COUNTS = {
  bedrooms: 4,
  fullBaths: 3,
  halfBaths: 1,
  office: 1,
  garageBays: 2,
  get fixtureUnitBedroomCount() { return this.bedrooms; },
};

export default {
  ORIENTATION, SITE_SLOPE, GRID, BAR, LEVELS, FOOTPRINTS, CRAWL, LINK, GARAGE,
  ROOMS, STAIRS, ROOFS, ROOF_ASSEMBLY, CLERESTORY, STRUCTURE, DECKS, DRAIN_GAP,
  SNOW, PROGRAM_COUNTS, roofTopAt, ceilingAt, areaSummary, roomById, roofById, levelById,
};
