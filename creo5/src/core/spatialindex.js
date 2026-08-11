// SPATIAL INDEX.
//
// A uniform grid over entity bounding boxes. Boxes here are an optimisation
// structure only — every candidate returned by the broadphase is re-tested
// against real polygon geometry before any answer leaves this module.

import * as G from './geom.js';

export class SpatialIndex {
  constructor(cell = 16, cellBudget = 40000) {
    this.cell = cell;
    this.cellBudget = cellBudget;
    this.cells = new Map();          // "i,j" -> Set(entityId)
    this.boxes = new Map();          // entityId -> bbox
    this.rings = new Map();          // entityId -> working ring (cached)
    this.z = new Map();              // entityId -> [zBase, zTop]
    this.huge = new Set();           // entities too large to bucket; tested directly
  }

  key(i, j) { return `${i},${j}`; }

  /**
   * Cells covered by a box. An entity whose footprint is 10 000 km across would
   * otherwise ask for billions of grid cells and take the tab down with it —
   * so anything past the budget is held in an oversize list and tested directly.
   * The index degrades; it does not die.
   */
  *cellsFor(bb) {
    if (!Number.isFinite(bb[0]) || !Number.isFinite(bb[1]) || !Number.isFinite(bb[2]) || !Number.isFinite(bb[3])) return;
    const i0 = Math.floor(bb[0] / this.cell), i1 = Math.floor(bb[2] / this.cell);
    const j0 = Math.floor(bb[1] / this.cell), j1 = Math.floor(bb[3] / this.cell);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > this.cellBudget) return;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) yield this.key(i, j);
  }

  oversized(bb) {
    const i0 = Math.floor(bb[0] / this.cell), i1 = Math.floor(bb[2] / this.cell);
    const j0 = Math.floor(bb[1] / this.cell), j1 = Math.floor(bb[3] / this.cell);
    return !Number.isFinite(bb[0]) || (i1 - i0 + 1) * (j1 - j0 + 1) > this.cellBudget;
  }

  insert(id, ring, zBase = 0, zTop = 0) {
    this.removeId(id);
    const bb = G.bbox(ring);
    this.boxes.set(id, bb);
    this.rings.set(id, ring);
    this.z.set(id, [zBase, zTop]);
    if (this.oversized(bb)) { this.huge.add(id); return; }
    for (const k of this.cellsFor(bb)) {
      let s = this.cells.get(k);
      if (!s) this.cells.set(k, (s = new Set()));
      s.add(id);
    }
  }

  removeId(id) {
    const bb = this.boxes.get(id);
    if (!bb) return;
    for (const k of this.cellsFor(bb)) this.cells.get(k)?.delete(id);
    this.huge.delete(id);
    this.boxes.delete(id); this.rings.delete(id); this.z.delete(id);
  }

  clear() { this.cells.clear(); this.boxes.clear(); this.rings.clear(); this.z.clear(); this.huge.clear(); }

  /** Rebuild from a branch view of the place. */
  rebuild(place, branchId) {
    this.clear();
    for (const e of place.all(branchId)) {
      const ring = place.ringOf(e);
      if (ring && ring.length >= 3) this.insert(e.id, ring, e.zBase, e.zTop);
    }
    return this;
  }

  candidates(bb) {
    const out = new Set(this.huge);         // always in the running: they are everywhere
    if (this.oversized(bb)) { for (const id of this.boxes.keys()) out.add(id); return out; }
    for (const k of this.cellsFor(bb)) {
      const s = this.cells.get(k);
      if (s) for (const id of s) out.add(id);
    }
    return out;
  }

  /** Ids whose real polygon contains the point. */
  atPoint(pt) {
    const bb = [pt[0], pt[1], pt[0], pt[1]];
    const out = [];
    for (const id of this.candidates(bb)) {
      const ring = this.rings.get(id);
      if (ring && G.pointInRing(pt, ring)) out.push(id);
    }
    return out;
  }

  /** Ids whose real polygon is within `r` metres of the point. */
  near(pt, r) {
    const bb = [pt[0] - r, pt[1] - r, pt[0] + r, pt[1] + r];
    const out = [];
    for (const id of this.candidates(bb)) {
      const ring = this.rings.get(id);
      if (!ring) continue;
      if (G.pointInRing(pt, ring)) { out.push({ id, d: 0 }); continue; }
      const c = G.closestOnRing(pt, ring);
      if (c.d <= r) out.push({ id, d: c.d });
    }
    return out.sort((a, b) => a.d - b.d);
  }

  /** Ids whose real polygon overlaps the query ring, with vertical-interval test. */
  overlapping(ring, zBase = -Infinity, zTop = Infinity, exclude = new Set()) {
    const bb = G.bbox(ring);
    const out = [];
    for (const id of this.candidates(bb)) {
      if (exclude.has(id)) continue;
      const other = this.rings.get(id);
      if (!other) continue;
      if (!G.ringsIntersect(ring, other)) continue;
      const [zb, zt] = this.z.get(id) || [0, 0];
      // Vertical intervals: a bridge over a road is not a collision.
      const vertical = !(zTop <= zb + 1e-6 || zt <= zBase + 1e-6);
      if (vertical) out.push(id);
    }
    return out;
  }

  /** Everything inside a query ring (fully contained). */
  within(ring) {
    const bb = G.bbox(ring);
    const out = [];
    for (const id of this.candidates(bb)) {
      const other = this.rings.get(id);
      if (other && G.ringContains(ring, other)) out.push(id);
    }
    return out;
  }

  ringFor(id) { return this.rings.get(id) || null; }
  size() { return this.boxes.size; }
}
