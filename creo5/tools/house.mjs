// THE BUILDING, NOT ITS CONTRACT.
//
// `bodyFromDesign` reads four things out of the design module — how long, how
// deep, how tall, which way it faces — and hands back a box. That is deliberate
// and it is right for what it is for: the certificate needs a footprint it can
// test, the water model needs an obstruction, the earthwork needs a pad. A
// contract is what makes a building answerable to a place.
//
// But it is not the building. `place-house.mjs` writes five rectangles into the
// world, so five rectangles is all any renderer reading the place can draw —
// while the design module carries two shed roofs at 3:12 both falling downhill,
// a clerestory where they step, a cantilevered deck, a retained lower terrace,
// a detached garage across a covered breezeway, and a masonry mass declared once
// so no drawing can contradict another. None of that survives the import,
// because none of it changes where the house sits or what it costs the hill.
//
// So this reads the design a second way, for the eye rather than for the
// certificate: the same module, the same numbers, no new authority. If a roof
// pitch here disagrees with the plans, it is a bug in this generator — which is
// exactly the argument geometry.mjs makes about its own drawings.
//
// Inches in, faces out. Nothing here decides anything about the site.

const IN_M = 0.0254;

export const FINISH = {
  siding: [0.60, 0.42, 0.28],
  roof: [0.22, 0.22, 0.23],
  glass: [0.40, 0.56, 0.64],
  concrete: [0.72, 0.70, 0.66],
  deck: [0.52, 0.41, 0.30],
  stone: [0.52, 0.49, 0.45],
  soffit: [0.44, 0.34, 0.25],
};

/** A closed polygon of design-inch points, with a finish. */
const face = (pts, col) => ({ pts, col });

function box(out, x0, x1, y0, y1, z0, z1, col, top = col) {
  out.push(face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], top));
  out.push(face([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], col));
  out.push(face([[x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]], col));
  out.push(face([[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]], col));
  out.push(face([[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], col));
}

/** A cross-section in (y, z), extruded along x — how a shed-roofed wing is shaped. */
function wing(out, x0, x1, section, col, capCol = col) {
  out.push(face(section.map(([y, z]) => [x0, y, z]), capCol));
  out.push(face(section.slice().reverse().map(([y, z]) => [x1, y, z]), capCol));
  for (let i = 0; i < section.length; i++) {
    const a = section[i], b = section[(i + 1) % section.length];
    out.push(face([[x0, a[0], a[1]], [x1, a[0], a[1]], [x1, b[0], b[1]], [x0, b[0], b[1]]], col));
  }
}

/** A roof plane, at its own pitch, with the overhangs the design gives it. */
function roofPlane(out, r, assembly, col, soffit) {
  const z = (y) => r.topAtY0 + (r.pitch / 12) * (y - r.y0);
  const x0 = r.x0 - (r.overhang?.west ?? 0), x1 = r.x1 + (r.overhang?.east ?? 0);
  const y0 = r.y0 - (r.overhang?.south ?? 0), y1 = r.y1 + (r.overhang?.north ?? 0);
  const P = (x, y, d) => [x, y, z(y) + d];
  out.push(face([P(x0, y0, 0), P(x1, y0, 0), P(x1, y1, 0), P(x0, y1, 0)], col));            // deck
  out.push(face([P(x0, y0, -assembly), P(x0, y1, -assembly),
    P(x1, y1, -assembly), P(x1, y0, -assembly)], soffit));                                   // soffit
  out.push(face([P(x0, y0, -assembly), P(x1, y0, -assembly), P(x1, y0, 0), P(x0, y0, 0)], col)); // eave fascia
  out.push(face([P(x1, y1, -assembly), P(x0, y1, -assembly), P(x0, y1, 0), P(x1, y1, 0)], col));
  out.push(face([P(x0, y1, -assembly), P(x0, y0, -assembly), P(x0, y0, 0), P(x0, y1, 0)], col));
  out.push(face([P(x1, y0, -assembly), P(x1, y1, -assembly), P(x1, y1, 0), P(x1, y0, 0)], col));
}

/**
 * The whole massing, in design inches.
 * @param {object} mod  the design module — the only source consulted
 */
export function houseFaces(mod) {
  const { BAR, LEVELS, FOOTPRINTS, CRAWL, LINK, GARAGE, ROOFS, DECKS, MASONRY,
    CLERESTORY, ROOF_ASSEMBLY, roofTopAt } = mod;
  const lvl = Object.fromEntries(LEVELS.map((l) => [l.id, l.ffe]));
  const roof = Object.fromEntries(ROOFS.map((r) => [r.id, r]));
  const out = [];
  const zOf = (r, y) => r.topAtY0 + (r.pitch / 12) * (y - r.y0);

  // ── the bar, as two wings under two shed roofs ────────────────────────────
  // Bays A–C stand on the lower slab and walk out; D–G sit over the sealed
  // crawl. The section is the same shape in both, at different bases.
  const sect = (r, base) => [
    [BAR.y0, base], [BAR.y1, base],
    [BAR.y1, zOf(r, BAR.y1) - ROOF_ASSEMBLY], [BAR.y0, zOf(r, BAR.y0) - ROOF_ASSEMBLY],
  ];
  wing(out, FOOTPRINTS.L0.x0, FOOTPRINTS.L0.x1, sect(roof.RA, lvl.L0), FINISH.siding);
  wing(out, FOOTPRINTS.L0.x1, roof.RA.x1, sect(roof.RA, CRAWL.ffe), FINISH.siding);
  wing(out, roof.RB.x0, roof.RB.x1, sect(roof.RB, CRAWL.ffe), FINISH.siding);

  // ── the clerestory: Roof B stands above Roof A and the step is glazed ─────
  out.push(face([
    [CLERESTORY.x, CLERESTORY.y0, CLERESTORY.zBotAtY0],
    [CLERESTORY.x, CLERESTORY.y1, CLERESTORY.zBotAtY1],
    [CLERESTORY.x, CLERESTORY.y1, CLERESTORY.zTopAtY1],
    [CLERESTORY.x, CLERESTORY.y0, CLERESTORY.zTopAtY0],
  ], FINISH.glass));

  // ── the glass line: the downhill face is the reason for the whole plan ────
  // Bays A–C at the lower level walk out; the great room above is the wall.
  const glassBand = (x0, x1, zBot, zTop) => out.push(face([
    [x0, BAR.y0 - 1, zBot], [x1, BAR.y0 - 1, zBot], [x1, BAR.y0 - 1, zTop], [x0, BAR.y0 - 1, zTop],
  ], FINISH.glass));
  glassBand(FOOTPRINTS.L0.x0, FOOTPRINTS.L0.x1, lvl.L0 + 8, lvl.L0 + 96);
  glassBand(BAR.x0, BAR.x1, lvl.L1 + 8, lvl.L1 + 96);
  glassBand(FOOTPRINTS.L2.x0, FOOTPRINTS.L2.x1, lvl.L2 + 8, lvl.L2 + 88);

  // ── roofs ─────────────────────────────────────────────────────────────────
  for (const id of ['RA', 'RB', 'RL', 'RG']) {
    if (roof[id]) roofPlane(out, roof[id], ROOF_ASSEMBLY, FINISH.roof, FINISH.soffit);
  }

  // ── the link, and the garage across its covered breezeway ─────────────────
  wing(out, LINK.x0, LINK.x1, [
    [LINK.y0, LINK.ffe - 18], [LINK.y1, LINK.ffe - 18],
    [LINK.y1, zOf(roof.RL, LINK.y1) - ROOF_ASSEMBLY], [LINK.y0, zOf(roof.RL, LINK.y0) - ROOF_ASSEMBLY],
  ], FINISH.siding);
  wing(out, GARAGE.x0, GARAGE.x1, [
    [GARAGE.y0, GARAGE.ffe - 18], [GARAGE.y1, GARAGE.ffe - 18],
    [GARAGE.y1, zOf(roof.RG, GARAGE.y1) - ROOF_ASSEMBLY], [GARAGE.y0, zOf(roof.RG, GARAGE.y0) - ROOF_ASSEMBLY],
  ], FINISH.concrete);
  // the breezeway is roofed, and that roof is why you get out of the car dry
  if (GARAGE.breezeway?.covered) {
    const b = GARAGE.breezeway;
    box(out, b.x0, b.x1, GARAGE.y0, LINK.y1, LINK.roofTop - 10, LINK.roofTop, FINISH.roof);
  }

  // ── decks and terraces ────────────────────────────────────────────────────
  for (const d of DECKS) {
    box(out, d.x0, d.x1, d.y0, d.y1, d.top - 10, d.top, FINISH.deck);
    // the lower terrace is retained stone, not a timber deck on posts
    if (d.id === 'D2') box(out, d.x0, d.x1, d.y0 - 8, d.y0, d.top - 58, d.top, FINISH.stone);
  }

  // ── the masonry mass: declared once, so it can be drawn from the declaration
  if (MASONRY) {
    const top = (roofTopAt ? roofTopAt((MASONRY.x0 + MASONRY.x1) / 2, (MASONRY.y0 + MASONRY.y1) / 2) : 340)
      + MASONRY.capAboveRoof;
    box(out, MASONRY.x0, MASONRY.x1, MASONRY.y0, MASONRY.y1, MASONRY.zBot, top, FINISH.stone);
  }

  return out;
}

/**
 * Design inches → the place's metres, at a seat and a turn.
 *
 * The pivot is the centre of the BAR, which is what `place-house.mjs` used when
 * it put the five rectangles down — so this massing lands exactly on them
 * rather than beside them.
 */
export function placedFaces(mod, { at, rotationDeg, floor }) {
  const cx = (mod.BAR.x0 + mod.BAR.x1) / 2, cy = (mod.BAR.y0 + mod.BAR.y1) / 2;
  const r = (rotationDeg * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  return houseFaces(mod).map((f) => ({
    col: f.col,
    pts: f.pts.map(([x, y, z]) => {
      const lx = (x - cx) * IN_M, ly = (y - cy) * IN_M;
      return [at[0] + lx * cos - ly * sin, at[1] + lx * sin + ly * cos, floor + z * IN_M];
    }),
  }));
}
