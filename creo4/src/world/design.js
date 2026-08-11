// A DESIGN MODULE IS A BODY.
//
// The Henry House has no .glb, and that turns out to be the better case. It is
// `model/geometry.mjs` — a module that computes the building and calls itself
// "the single source of truth: if two drawings disagree, it is a bug in a
// generator, not a coordination error in the design."
//
// Exporting that to a mesh would throw away everything that makes it useful. A
// mesh knows where its triangles are; the module knows that the bar is 72 feet
// by 26, that there are three levels ten feet apart, that the long axis bears
// N70°E and WHY, and that every site elevation is assumed pending survey. CREO
// wants the contract, not the triangles — so it reads the module.
//
// The seam is deliberately small, because it has to fit designs nobody has
// written yet. A module is a design if it can answer four questions:
//
//   how long and how deep   BAR, or FOOTPRINTS, or an explicit footprint
//   how tall                LEVELS, or a height
//   which way it faces      ORIENTATION.longAxisAzimuth
//   what it assumes         SITE_SLOPE — so the ground can contradict it
//
// Anything answering those can be swapped onto the site and seated, and the
// earthwork will be measured for it. Nothing here is Henry-House-specific; that
// house is simply the first one that exists.

import { boxBody } from './body.js';

const IN_TO_M = 0.0254;

/**
 * @param {object} mod  a design module, already imported
 * @param {object} opts { name, units } — units default to inches, which is what
 *                      an American set of drawings is in
 */
export function bodyFromDesign(mod, { name = 'design', units = IN_TO_M } = {}) {
  const extent = extentOf(mod);
  if (!extent) throw new Error('this module does not say how big the building is');

  const long = (extent.x1 - extent.x0) * units;
  const deep = (extent.y1 - extent.y0) * units;
  const height = heightOf(mod, units) || 6;

  const body = boxBody({ id: `design-${name}`, name, width: long, depth: deep, height });

  // What the design believes about its site, kept so the ground can disagree
  // with it out loud rather than being quietly overruled.
  body.assumes = {
    azimuth: mod.ORIENTATION?.longAxisAzimuth ?? null,
    azimuthNote: mod.ORIENTATION?.note ?? null,
    crossSlopePercent: mod.SITE_SLOPE?.crossSlopePct ?? null,
    longSlopePercent: mod.SITE_SLOPE?.longSlopePct ?? null,
  };
  body.levels = (mod.LEVELS || []).map((l) => ({ id: l.id, ffe: (l.ffe ?? 0) * units }));
  body.source = { kind: 'design module', name, exports: Object.keys(mod).length };
  return body;
}

function extentOf(mod) {
  if (mod.BAR && Number.isFinite(mod.BAR.x1)) return mod.BAR;
  const fps = Object.values(mod.FOOTPRINTS || {}).filter((f) => Number.isFinite(f?.x1));
  if (!fps.length) return null;
  // the whole building is the union of its floors
  return {
    x0: Math.min(...fps.map((f) => f.x0)), x1: Math.max(...fps.map((f) => f.x1)),
    y0: Math.min(...fps.map((f) => f.y0)), y1: Math.max(...fps.map((f) => f.y1)),
  };
}

function heightOf(mod, units) {
  const levels = (mod.LEVELS || []).map((l) => l.ffe).filter(Number.isFinite);
  if (!levels.length) return null;
  const span = Math.max(...levels) - Math.min(...levels);
  const storey = levels.length > 1 ? span / (levels.length - 1) : span;
  // the top floor still needs a floor-to-roof of its own
  return (span + storey) * units;
}

/**
 * What the ground says about what the design assumed.
 *
 * This is the point of the whole exercise. A design states its site; the site
 * is measurable; CREO puts the two side by side and refuses to average them.
 * Every row is "assumed / measured / by how much", and CREO takes no view about
 * which is right — the module says its figures are pending survey, and CREO's
 * ground is public data interpolated to building scale, so NEITHER of these is
 * a survey and both of them say so.
 */
export function checkAgainstGround(body, world, ring, { samples = 24 } = {}) {
  const G = ringHelpers(world);
  const spots = G.sample(ring, samples);
  if (!spots.length) return { rows: [], note: 'no ground inside that boundary' };

  const grades = spots.map((s) => s.grade).sort((a, b) => a - b);
  const median = grades[Math.floor(grades.length / 2)];
  const gentle = spots.filter((s) => s.grade <= (body.assumes?.crossSlopePercent ?? 30));
  const contours = gentle.length
    ? gentle.map((s) => s.contour).sort((a, b) => a - b)
    : spots.map((s) => s.contour).sort((a, b) => a - b);
  const contour = contours[Math.floor(contours.length / 2)];

  const rows = [];
  if (body.assumes?.crossSlopePercent != null) {
    rows.push({
      of: 'cross slope',
      assumed: `${body.assumes.crossSlopePercent}%`,
      measured: `${median.toFixed(0)}% median, ${grades[0].toFixed(0)}–${grades[grades.length - 1].toFixed(0)}%`,
      by: `${(median - body.assumes.crossSlopePercent).toFixed(0)} points steeper`,
      easy: `${Math.round((100 * gentle.length) / spots.length)}% of the ground is at or under what it assumes`,
    });
  }
  if (body.assumes?.azimuth != null) {
    const off = Math.min(Math.abs(contour - body.assumes.azimuth), 180 - Math.abs(contour - body.assumes.azimuth));
    rows.push({
      of: 'long axis, meant to lie along the contour',
      assumed: `N${body.assumes.azimuth}°E`,
      measured: `N${contour.toFixed(0)}°E on the buildable ground`,
      by: `${off.toFixed(0)}° off`,
      easy: off < 15 ? 'close enough to call along the contour' : 'not along the contour there',
    });
  }
  return {
    rows,
    note: body.assumes?.azimuthNote || null,
    caution: 'the design says its site figures are assumed pending survey, and CREO\'s ground '
      + 'is public elevation interpolated to building scale — neither of these is a survey',
  };
}

function ringHelpers(world) {
  return {
    sample(ring, n) {
      const b = [
        Math.min(...ring.map((p) => p[0])), Math.min(...ring.map((p) => p[1])),
        Math.max(...ring.map((p) => p[0])), Math.max(...ring.map((p) => p[1])),
      ];
      const step = Math.max(10, Math.max(b[2] - b[0], b[3] - b[1]) / n);
      const out = [];
      const inside = (x, y) => {
        let hit = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i], [xj, yj] = ring[j];
          if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
        }
        return hit;
      };
      for (let y = b[1]; y <= b[3]; y += step) {
        for (let x = b[0]; x <= b[2]; x += step) {
          if (!inside(x, y)) continue;
          const s = world.place.terrain.slopeAt(x, y);
          const fall = (Math.atan2(-s.dzdx, -s.dzdy) * 180) / Math.PI;
          out.push({ at: [x, y], grade: s.grade * 100, contour: (((fall + 90) % 180) + 180) % 180 });
        }
      }
      return out;
    },
  };
}
