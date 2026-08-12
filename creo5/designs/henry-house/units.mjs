// HENRY HOUSE — units and formatting.
//
// BASE UNIT IS THE INCH. Everything in the model is an integer or simple
// fraction of inches. Elevations are inches above PROJECT DATUM.
//
// PROJECT DATUM (Z = 0) is set at the LOWER LEVEL finished floor, and every z
// in the model is inches above it. The datum is LOCAL: relative geometry does
// not depend on what it correlates to in feet above sea level, which is why
// nothing here moved when that correlation turned out to be wrong.
//
// It was assumed to be 3,412 ft AMSL. Measured at the coordinate the client
// gave, the ground is about **2,364 ft** — roughly 1,050 ft lower (docs/01 M-1).
//
// WHAT THAT DOES AND DOES NOT INVALIDATE. Not one dimension, level, section or
// plan: they are all relative to this datum. But every argument in the package
// that reasoned FROM the altitude — ground snow load, design temperature,
// freeze depth, the ice-storm case for standby power, and the freeze rule that
// keeps plumbing out of exterior walls — was made at 3,400 ft and has not been
// recomputed at 2,364 ft. Those arguments are still directionally right (this
// is a cold mountain site in either case) and their NUMBERS are unverified.
//
// Prose elsewhere in the model still says "3,400 ft" — in the scheme critiques,
// the precedent notes and the VSM commentary. Those are a record of what was
// argued at the time and are deliberately not rewritten; the correction lives
// here and in docs/01, where a reader looks for facts rather than for history.

export const IN = 1;
export const FT = 12;

/** feet (and optional inches) -> inches */
export const ft = (f, i = 0) => f * 12 + i;

/** inches -> decimal feet */
export const toFt = (inches) => inches / 12;

/** Format inches as an architectural dimension string: 12'-6 1/2" */
export function dim(inches, { precision = 16, forceInches = false } = {}) {
  const neg = inches < 0;
  let v = Math.abs(inches);
  const whole = Math.floor(v);
  let frac = Math.round((v - whole) * precision);
  let w = whole;
  if (frac === precision) { w += 1; frac = 0; }
  const feet = Math.floor(w / 12);
  const ins = w % 12;
  let fracStr = '';
  if (frac > 0) {
    let n = frac, d = precision;
    while (n % 2 === 0 && d % 2 === 0) { n /= 2; d /= 2; }
    fracStr = ` ${n}/${d}`;
  }
  const s = (feet === 0 && !forceInches)
    ? `${ins}${fracStr}"`
    : `${feet}'-${ins}${fracStr}"`;
  return (neg ? '-' : '') + s;
}

/** Format an elevation (inches above datum) as a US survey-style elevation. */
export const DATUM_FT = 100; // "EL. 100'-0"" == project datum == lower level FF
export function el(inches) {
  const totalIn = DATUM_FT * 12 + inches;
  return `EL. ${dim(totalIn)}`;
}

/** square inches -> square feet, rounded */
export const sf = (sqIn) => Math.round(sqIn / 144);

/** Polygon area (shoelace), square inches. pts = [[x,y],...] */
export function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2);
}

/** Rectangle helper -> polygon */
export const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

/** Slope helpers */
export const pitchRise = (pitch, run) => (pitch / 12) * run; // pitch as "n in 12"
export const pctToRatio = (pct) => pct / 100;
export const ratioToPct = (r) => r * 100;
export const degFromPct = (pct) => (Math.atan(pct / 100) * 180) / Math.PI;

/** Round to nearest n */
export const snap = (v, n = 1) => Math.round(v / n) * n;

/** Linear interpolation */
export const lerp = (a, b, t) => a + (b - a) * t;

/** Clamp */
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
