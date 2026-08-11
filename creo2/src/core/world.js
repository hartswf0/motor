// THE WORLD — Place + Journal + SpatialIndex + derived relations, kept coherent.
//
// Everything that mutates PLACE goes through here, so the index and the relation
// graph can never drift from the model. There is no AI mode and no manual mode.

import { Place, Heightfield } from './place.js';
import { Journal } from './tx.js';
import { SpatialIndex } from './spatialindex.js';
import { deriveRelations } from './relations.js';
import * as G from './geom.js';

export class World {
  constructor(place) {
    this.place = place;
    this.journal = new Journal(place);
    this.index = new SpatialIndex(16);
    this.dirty = true;
    this.observers = new Set();
    this.journal.on((kind, ev) => { this.dirty = true; this.notify(kind, ev); });
    this.reindex();
  }

  on(fn) { this.observers.add(fn); return () => this.observers.delete(fn); }
  notify(kind, payload) { for (const fn of this.observers) fn(kind, payload); }

  reindex(force = false) {
    if (!this.dirty && !force) return this.index;
    this.index.rebuild(this.place, this.place.activeBranch);
    deriveRelations(this.place, this.index, this.place.activeBranch);
    this.dirty = false;
    return this.index;
  }

  get branch() { return this.place.activeBranch; }

  /** Read-side helpers used by every other subsystem. */
  entities() { return this.place.all(this.branch); }
  get(id) { return this.place.get(id, this.branch); }
  ringOf(e) { return this.place.ringOf(e); }

  entityAt(pt) {
    this.reindex();
    const ids = this.index.atPoint(pt);
    if (!ids.length) return null;
    // Topmost thing wins — that is what a person means when they point.
    let best = null;
    for (const id of ids) {
      const e = this.get(id);
      if (!e) continue;
      if (!best || e.zTop > best.zTop || (e.zTop === best.zTop && e.type !== 'surface')) best = e;
    }
    return best;
  }

  nearby(pt, r = 20) {
    this.reindex();
    return this.index.near(pt, r).map((h) => ({ entity: this.get(h.id), d: h.d })).filter((h) => h.entity);
  }

  /** Run a transaction, then keep index + relations in step. */
  transact(meta, fn) {
    const out = this.journal.transact(meta, fn);
    this.dirty = true;
    this.reindex();
    return out;
  }

  addEntity(props, meta = {}) {
    const id = props.id || this.place.newId(props.type);
    let created = null;
    this.transact({ label: meta.label || `add ${props.type}`, ...meta }, (j) => {
      created = j.mutate({ op: 'add', branch: meta.branch || this.branch, entity: { ...props, id, createdAt: this.place.tick + 1 } }).after;
    });
    return this.get(id) || created;
  }

  updateEntity(id, patch, meta = {}) {
    this.transact({ label: meta.label || `edit ${id}`, ...meta }, (j) => {
      j.mutate({ op: 'update', branch: meta.branch || this.branch, id, patch });
    });
    return this.get(id);
  }

  removeEntity(id, meta = {}) {
    this.transact({ label: meta.label || `remove ${id}`, ...meta }, (j) => {
      j.mutate({ op: 'remove', branch: meta.branch || this.branch, id });
    });
  }

  undo() { const e = this.journal.undo(); this.dirty = true; this.reindex(); return e; }
  redo() { const e = this.journal.redo(); this.dirty = true; this.reindex(); return e; }

  // ------------------------------------------------------------- branches ---
  createBranch(id, opts = {}) {
    this.transact({ label: `branch ${opts.name || id}`, author: opts.author }, (j) => {
      j.mutate({ op: 'branch', branchId: id, name: opts.name, parent: opts.parent ?? this.branch, note: opts.note, author: opts.author });
    });
    return this.place.branches.get(id);
  }

  switchBranch(id) {
    if (id === this.branch) return;
    this.place.setActiveBranch(id);
    this.dirty = true;
    this.reindex();
    this.notify('branch', id);
  }

  /** Read a branch without switching to it — needed for side-by-side compare. */
  view(branchId) {
    const prev = this.place.activeBranch;
    this.place.activeBranch = branchId;
    const idx = new SpatialIndex(16).rebuild(this.place, branchId);
    const list = this.place.all(branchId);
    this.place.activeBranch = prev;
    return { entities: list, index: idx, branchId };
  }

  // -------------------------------------------------------------- persist ---
  save() {
    // Rounding here would mean a reloaded world differed from the one saved,
    // which breaks the invariant the whole history depends on. Imported data is
    // rounded on the way IN instead, where it is honest about its own precision.
    return JSON.stringify({
      version: 1,
      place: this.place.toJSON(),
      journal: this.journal.toJSON(),
    });
  }

  static load(text) {
    const j = JSON.parse(text);
    const place = Place.fromJSON(j.place, Heightfield);
    const w = new World(place);
    w.journal.loadJSON(j.journal);
    w.dirty = true;
    w.reindex();
    return w;
  }

  /**
   * Stable fingerprint — the instrument the save/reload and undo invariants are
   * measured with. It must therefore be sensitive to everything a person could
   * lose: not only geometry, but who made a thing, what it is made of, whether
   * it is solid, what it cites as evidence, and every vertex. An instrument that
   * calls "City Hall" and "prank shed" the same world is not evidence of
   * anything.
   */
  fingerprint() {
    const ents = this.place.all(this.branch)
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((e) => {
        const ring = this.place.ringOf(e);
        const geom = ring ? ring.map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join(' ') : '-';
        const semantic = [
          e.id, e.type, e.subtype, e.name, e.status, e.epistemic, e.certainty,
          e.author, e.source, e.material, e.use, e.collision, e.network, e.parent,
          e.width, (e.tags || []).join('+'),
        ].join('|');
        const deep = hash(JSON.stringify([e.props || {}, e.sim || {}, e.evidence || []]));
        return `${semantic}|${e.zBase.toFixed(3)}|${e.zTop.toFixed(3)}|${hash(geom)}|${deep}`;
      });
    const rels = this.place.relations
      .map((r) => `${r.from}-${r.kind}->${r.to}${r.derived ? '*' : ''}|${r.author || ''}|${r.note || ''}|${r.distance ?? ''}`)
      .sort()
      .join(';');
    const branches = [...this.place.branches.values()]
      .map((b) => `${b.id}<${b.parent || '-'}>${b.name}${b.status}`)
      .sort()
      .join(';');
    // The id allocator is deliberately absent: it counts forward and is never
    // rewound by undo, so including it would make undo look broken when it is not.
    return `${ents.join('\n')}\n#rel ${hash(rels)}\n#branches ${hash(branches)}\n#tick ${this.place.tick}\n#branch ${this.branch}`;
  }
}

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
