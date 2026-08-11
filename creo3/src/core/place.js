// THE PLACE MODEL — the one canonical world.
//
// Renderer, physics, AI, spatial queries, simulation, multiplayer, history and
// export all read *this*. There is no second reality for AI objects, imported
// objects, game objects or community annotations. There are only entities in a
// PLACE, with different types, relations, provenance, certainty and authors.

import * as G from './geom.js';

// Epistemic states (§18). Authority is not truth; both can live here at once.
export const EPISTEMIC = [
  'IMPORTED', 'OBSERVED', 'MEASURED', 'INFERRED',
  'PROPOSED', 'SIMULATED', 'DISPUTED', 'CONFIRMED', 'BUILT', 'REMOVED',
];

// Relationship kinds (§6). Derived ones are recomputed; asserted ones are authored.
export const RELATIONS = [
  'inside', 'contains', 'above', 'below', 'beside', 'between', 'faces', 'touches',
  'supports', 'supportedBy', 'connectedTo', 'drainsTo', 'flowsTo', 'blocks', 'crosses',
  'accessibleFrom', 'visibleFrom', 'usedBy', 'ownedBy', 'claimedBy', 'proposedBy',
  'preserves', 'replaces', 'conflictsWith', 'derivedFrom', 'disputedBy',
];

export const DERIVED_RELATIONS = new Set([
  'inside', 'contains', 'above', 'below', 'beside', 'touches',
  'supports', 'supportedBy', 'blocks', 'crosses', 'connectedTo',
]);

/**
 * One entity. Geometry is a footprint ring (metres) plus a vertical interval,
 * or an open path for network elements. Every entity knows far more than xyz.
 */
export function makeEntity(props) {
  return {
    id: props.id,
    type: props.type,                       // structure | room | road | path | rail | drain | water | tree | surface | region | parcel | observation | marker | opening | wall | furniture …
    name: props.name || null,
    footprint: props.footprint || null,     // [[x,y], …] closed ring, metres
    path: props.path || null,               // [[x,y], …] open polyline, metres
    width: props.width ?? null,             // for path-like entities
    zBase: props.zBase ?? 0,                // metres above local datum
    zTop: props.zTop ?? (props.zBase ?? 0), // vertical interval, not a bounding box
    parent: props.parent || null,
    children: props.children || [],
    // semantics
    subtype: props.subtype || null,
    use: props.use || null,
    material: props.material || null,
    network: props.network || null,         // 'streets' | 'paths' | 'drainage' | …
    nodes: props.nodes || null,             // network endpoints [aId, bId]
    // epistemics + provenance (§19: every object can answer "why are you here?")
    epistemic: props.epistemic || 'IMPORTED',
    certainty: props.certainty ?? 1,
    source: props.source || 'seed',
    author: props.author || 'system',
    createdBy: props.createdBy || null,     // event id
    createdAt: props.createdAt ?? 0,        // logical tick, never wall clock
    evidence: props.evidence || [],         // {kind:'utterance'|'photo'|'measure'|'sim', …}
    // world state
    status: props.status || 'ACTIVE',       // ACTIVE | GHOST | REMOVED | ARCHIVED
    branch: props.branch || 'AS_IS',
    collision: props.collision || 'solid',  // solid | soft | none
    sim: props.sim || {},                   // permeability, roughness, capacity …
    tags: props.tags || [],
    style: props.style || null,
    // free-form but declared
    props: props.props || {},
  };
}

/**
 * Ids are allocated per Place, never from module-global state.
 * A global counter meant that loading one save rewound the allocator for every
 * other Place alive in the process — two worlds would then mint the same id and
 * one would silently overwrite the other. Per-place counters make that
 * impossible while keeping ids deterministic for a given place.
 */
export function formatId(type, n) {
  return `${type}_${n.toString(36).padStart(3, '0')}`;
}

/**
 * A branch is a named world-state: an overlay of entity changes on top of its
 * parent. AS_IF is a first-class world operation — imagining a future must never
 * destroy the present (§13).
 */
export function makeBranch(id, { name, parent = null, note = '', author = 'system', createdAt = 0 }) {
  return { id, name: name || id, parent, note, author, createdAt, status: 'OPEN' };
}

export class Place {
  constructor({ id = 'place', name = 'Place', anchor = [0, 0], seed = 1 } = {}) {
    this.id = id;
    this.name = name;
    this.seed = seed;
    this.projection = G.makeProjection(anchor[0], anchor[1]);
    /** @type {Map<string, any>} base (AS_IS) entities */
    this.entities = new Map();
    /** branchId -> Map(entityId -> entity | REMOVED_MARKER) */
    this.overlays = new Map();
    this.branches = new Map();
    this.relations = [];                    // {from, kind, to, derived, author, note}
    this.terrain = null;                    // Heightfield
    this.tick = 0;
    this.landmarks = new Map();             // name -> [x,y] for "toward the river"
    this.uid = 0;                           // this place's own id allocator
    this.meta = null;                       // provenance of the place itself (source, licence, bbox)
    const root = makeBranch('AS_IS', { name: 'As it is' });
    this.branches.set('AS_IS', root);
    this.overlays.set('AS_IS', new Map());
    this.activeBranch = 'AS_IS';
  }

  /** Next id for this place. Deterministic per place, unique within it. */
  newId(type) { return formatId(type, ++this.uid); }

  // ------------------------------------------------------------- branches ---
  branchChain(branchId = this.activeBranch) {
    const chain = [];
    let b = this.branches.get(branchId);
    while (b) { chain.unshift(b.id); b = b.parent ? this.branches.get(b.parent) : null; }
    return chain;
  }

  createBranch(id, opts) {
    const b = makeBranch(id, { parent: opts.parent ?? this.activeBranch, ...opts });
    this.branches.set(id, b);
    this.overlays.set(id, new Map());
    return b;
  }

  setActiveBranch(id) {
    if (!this.branches.has(id)) throw new Error(`no branch ${id}`);
    this.activeBranch = id;
  }

  // ------------------------------------------------------------- entities ---
  /** Resolve an entity as seen from a branch (overlay chain, nearest wins). */
  get(id, branchId = this.activeBranch) {
    const chain = this.branchChain(branchId);
    for (let i = chain.length - 1; i >= 0; i--) {
      const ov = this.overlays.get(chain[i]);
      if (ov && ov.has(id)) {
        const e = ov.get(id);
        return e === null ? null : e;      // null = removed on this branch
      }
    }
    return this.entities.get(id) || null;
  }

  /** Every visible entity in a branch, base + overlays, removals applied. */
  all(branchId = this.activeBranch) {
    const chain = this.branchChain(branchId);
    const out = new Map(this.entities);
    for (const bid of chain) {
      const ov = this.overlays.get(bid);
      if (!ov) continue;
      for (const [id, e] of ov) { if (e === null) out.delete(id); else out.set(id, e); }
    }
    const list = [];
    for (const e of out.values()) if (e.status !== 'REMOVED' && e.status !== 'ARCHIVED') list.push(e);
    return list;
  }

  /** Write an entity into a branch overlay (AS_IS writes to the base map). */
  put(entity, branchId = this.activeBranch) {
    // An entity with no id would silently overwrite the last one that also had
    // none. Losing data quietly is worse than failing loudly.
    if (!entity || typeof entity.id !== 'string' || !entity.id) {
      throw new Error(`cannot store an entity without an id (type ${entity?.type})`);
    }
    if (branchId === 'AS_IS') this.entities.set(entity.id, entity);
    else this.overlays.get(branchId).set(entity.id, entity);
    return entity;
  }

  remove(id, branchId = this.activeBranch) {
    if (branchId === 'AS_IS') {
      const e = this.entities.get(id);
      if (e) this.entities.set(id, { ...e, status: 'REMOVED' });
    } else {
      this.overlays.get(branchId).set(id, null);
    }
  }

  byType(type, branchId = this.activeBranch) {
    return this.all(branchId).filter((e) => e.type === type);
  }

  // ------------------------------------------------------------ relations ---
  relate(from, kind, to, meta = {}) {
    this.relations.push({ from, kind, to, derived: false, ...meta });
  }
  relationsOf(id) {
    return this.relations.filter((r) => r.from === id || r.to === id);
  }
  clearDerivedRelations() {
    this.relations = this.relations.filter((r) => !r.derived);
  }

  // -------------------------------------------------------------- geometry --
  /** Working ring for any entity — path-like entities are buffered to their width. */
  ringOf(e) {
    if (e.footprint) return e.footprint;
    if (e.path) return G.bufferPolyline(e.path, (e.width || 2) / 2);
    return null;
  }

  groundAt(x, y) { return this.terrain ? this.terrain.heightAt(x, y) : 0; }

  bounds(branchId = this.activeBranch) {
    let bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const e of this.all(branchId)) {
      const ring = this.ringOf(e);
      if (!ring) continue;
      const b = G.bbox(ring);
      bb = [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])];
    }
    if (!isFinite(bb[0])) return this.terrain ? this.terrain.bounds : [-50, -50, 50, 50];
    return bb;
  }

  // ------------------------------------------------------- serialisation ----
  toJSON() {
    return {
      id: this.id, name: this.name, seed: this.seed, tick: this.tick,
      anchor: this.projection.anchor,
      activeBranch: this.activeBranch,
      terrain: this.terrain ? this.terrain.toJSON() : null,
      entities: [...this.entities.values()],
      overlays: [...this.overlays.entries()].map(([bid, m]) => [bid, [...m.entries()]]),
      branches: [...this.branches.values()],
      relations: this.relations,
      landmarks: [...this.landmarks.entries()],
      // Where this place came from and under what licence travels WITH it.
      // Losing it on save would strip the attribution ODbL requires.
      meta: this.meta || null,
      uid: this.uid,
    };
  }

  static fromJSON(json, HeightfieldCtor) {
    const p = new Place({ id: json.id, name: json.name, anchor: json.anchor, seed: json.seed });
    p.tick = json.tick;
    p.entities = new Map(json.entities.map((e) => [e.id, e]));
    p.branches = new Map(json.branches.map((b) => [b.id, b]));
    p.overlays = new Map(json.overlays.map(([bid, entries]) => [bid, new Map(entries)]));
    p.relations = json.relations;
    p.landmarks = new Map(json.landmarks);
    p.activeBranch = json.activeBranch;
    if (json.terrain && HeightfieldCtor) p.terrain = HeightfieldCtor.fromJSON(json.terrain);
    p.uid = json.uid || 0;
    p.meta = json.meta || null;
    return p;
  }
}

/** Terrain as a real heightfield — slope and flow depend on it. */
/**
 * THE GROUND. One surface, and the only one.
 *
 * Formerly a Heightfield that interpolated bilinearly while the renderer drew
 * flat triangles over it — two surfaces, both called "the ground", disagreeing
 * everywhere between the samples. That single permission produced half of every
 * defect in CREO-01: roads a fifth buried and up to 9.7 m under the hill,
 * contours dashed across the steep faces, drawn regions 15.9 m out, a 17-hectare
 * wood floating sixty metres in the air. See ../THEORY.md §0.
 *
 * So: heightAt is planar within a triangle, and `triangles()` emits exactly the
 * triangles heightAt evaluates. A renderer that draws them and a simulation that
 * asks for a height cannot disagree, because there is nothing to disagree with.
 *
 * Provenance is per sample, because refinement invents values and a model that
 * cannot tell survey from interpolation will eventually present one as the other.
 */
export const MEASURED = 0;
export const INTERPOLATED = 1;
export const SETTLED = 2;
const PROV_NAMES = ['measured', 'interpolated', 'settled'];

export class Heightfield {
  constructor(bounds, cell, data = null, provenance = null) {
    if (!(cell > 0) || !Number.isFinite(cell)) throw new Error('a ground needs a positive cell size');
    this.bounds = bounds;                    // [x0,y0,x1,y1]
    this.cell = cell;
    this.nx = Math.max(2, Math.round((bounds[2] - bounds[0]) / cell) + 1);
    this.ny = Math.max(2, Math.round((bounds[3] - bounds[1]) / cell) + 1);
    this.data = data || new Float32Array(this.nx * this.ny);
    this.prov = provenance || new Uint8Array(this.nx * this.ny).fill(MEASURED);
  }
  idx(i, j) { return j * this.nx + i; }
  at(i, j) {
    const ii = Math.max(0, Math.min(this.nx - 1, i));
    const jj = Math.max(0, Math.min(this.ny - 1, j));
    return this.data[this.idx(ii, jj)];
  }

  /** I1 — the only height. Planar, on the diagonal `triangles()` uses. */
  heightAt(x, y) {
    const fx = (x - this.bounds[0]) / this.cell;
    const fy = (y - this.bounds[1]) / this.cell;
    const i = Math.floor(fx), j = Math.floor(fy);
    const u = fx - i, v = fy - j;
    const h00 = this.at(i, j), h10 = this.at(i + 1, j);
    const h11 = this.at(i + 1, j + 1), h01 = this.at(i, j + 1);
    return v <= u
      ? h00 + (h10 - h00) * u + (h11 - h10) * v
      : h00 + (h11 - h01) * u + (h01 - h00) * v;
  }

  /** The surface as drawn — derived from heightAt's rule, never parallel to it. */
  * triangles(step = 1) {
    for (let j = 0; j + step < this.ny; j += step) {
      for (let i = 0; i + step < this.nx; i += step) {
        const x0 = this.bounds[0] + i * this.cell, y0 = this.bounds[1] + j * this.cell;
        const x1 = x0 + this.cell * step, y1 = y0 + this.cell * step;
        const a = [x0, y0, this.at(i, j)];
        const b = [x1, y0, this.at(i + step, j)];
        const c = [x1, y1, this.at(i + step, j + step)];
        const d = [x0, y1, this.at(i, j + step)];
        yield [a, b, c];
        yield [a, c, d];
      }
    }
  }

  slopeAt(x, y) {
    const d = this.cell;
    const dzdx = (this.heightAt(x + d, y) - this.heightAt(x - d, y)) / (2 * d);
    const dzdy = (this.heightAt(x, y + d) - this.heightAt(x, y - d)) / (2 * d);
    return { dzdx, dzdy, grade: Math.hypot(dzdx, dzdy) };
  }

  normalAt(x, y) {
    const s = this.slopeAt(x, y);
    const len = Math.hypot(s.dzdx, s.dzdy, 1);
    return [-s.dzdx / len, -s.dzdy / len, 1 / len];
  }

  // ---------------------------------------------------- I2 and I3 ----------
  /** The smallest thing this ground can record, as opposed to compute. */
  finestRepresentable() { return this.cell * 2; }

  provenanceAt(x, y) {
    const fx = (x - this.bounds[0]) / this.cell, fy = (y - this.bounds[1]) / this.cell;
    const i = Math.floor(fx), j = Math.floor(fy);
    let worst = MEASURED;
    for (const [di, dj] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const ii = Math.max(0, Math.min(this.nx - 1, i + di));
      const jj = Math.max(0, Math.min(this.ny - 1, j + dj));
      worst = Math.max(worst, this.prov[this.idx(ii, jj)]);
    }
    return PROV_NAMES[worst];
  }
  isMeasured(x, y) { return this.provenanceAt(x, y) === 'measured'; }

  /**
   * Make the ground able to hold an intervention of a given size, or refuse.
   * Adds no information — every new value is interpolation of the same samples —
   * but adds the capacity to be changed, which is what a building pad needs.
   */
  refineFor(sizeM, { maxSamples = 4e6 } = {}) {
    if (this.finestRepresentable() <= sizeM) return { refined: false, reason: 'already fine enough', field: this };
    const want = sizeM / 4;
    const nx = Math.round((this.bounds[2] - this.bounds[0]) / want) + 1;
    const ny = Math.round((this.bounds[3] - this.bounds[1]) / want) + 1;
    if (nx * ny > maxSamples) {
      return { refined: false, refused: true, field: this,
        reason: `recording ${sizeM} m detail here needs ${(nx * ny / 1e6).toFixed(1)}M samples` };
    }
    const fine = new Heightfield(this.bounds, want);
    for (let j = 0; j < fine.ny; j++) {
      for (let i = 0; i < fine.nx; i++) {
        const x = fine.bounds[0] + i * fine.cell, y = fine.bounds[1] + j * fine.cell;
        const k = fine.idx(i, j);
        fine.data[k] = this.heightAt(x, y);
        const onOld = Math.abs(((x - this.bounds[0]) / this.cell) % 1) < 1e-9
          && Math.abs(((y - this.bounds[1]) / this.cell) % 1) < 1e-9;
        fine.prov[k] = onOld && this.isMeasured(x, y) ? MEASURED : INTERPOLATED;
      }
    }
    return { refined: true, field: fine, from: this.cell, cell: fine.cell, samples: fine.data.length };
  }

  /** Reshape the ground, recording that it was reshaped rather than found. */
  settle(inside, heightFor) {
    const before = [];
    for (let j = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++) {
        const x = this.bounds[0] + i * this.cell, y = this.bounds[1] + j * this.cell;
        if (!inside(x, y)) continue;
        const k = this.idx(i, j);
        const target = heightFor(x, y, this.data[k]);
        if (target === null || Math.abs(target - this.data[k]) < 1e-4) continue;
        before.push([k, this.data[k], this.prov[k]]);
        this.data[k] = target;
        this.prov[k] = SETTLED;
      }
    }
    this.__lo = undefined;
    return { changed: before.length,
      restore: () => { for (const [k, z, p] of before) { this.data[k] = z; this.prov[k] = p; } this.__lo = undefined; } };
  }

  toJSON() { return { bounds: this.bounds, cell: this.cell, data: [...this.data], prov: [...this.prov] }; }
  static fromJSON(j) {
    return new Heightfield(j.bounds, j.cell, Float32Array.from(j.data),
      j.prov ? Uint8Array.from(j.prov) : null);
  }
}
