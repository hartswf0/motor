// TRANSACTIONS + HISTORY.
//
// Every change to PLACE — human, AI, simulation or import — travels through one
// transaction log. Undo must restore world state exactly; save/reload must
// reproduce it byte-for-byte. This is what makes provenance possible at all:
// an entity's history is just the events that touched it.

import { makeEntity } from './place.js';

const clone = (v) => (v === null || v === undefined ? v : JSON.parse(JSON.stringify(v)));

/**
 * A transaction is a list of primitive mutations plus the intent that caused it.
 * Mutations are stored with before/after snapshots so inversion is exact rather
 * than re-derived.
 */
export class Journal {
  constructor(place) {
    this.place = place;
    this.events = [];        // committed transactions
    this.cursor = 0;         // number of applied events (undo moves it back)
    this.nextEventId = 1;
    this.listeners = new Set();
    this.open = null;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind, payload) { for (const fn of this.listeners) fn(kind, payload); }

  begin(meta = {}) {
    if (this.open) throw new Error('transaction already open');
    this.open = {
      id: `ev_${this.nextEventId}`,
      tick: this.place.tick + 1,
      author: meta.author || 'anon',
      branch: meta.branch || this.place.activeBranch,
      label: meta.label || 'change',
      intent: meta.intent || null,          // the interpreted operation
      utterance: meta.utterance || null,    // the ORIGINAL human expression, untranslated
      mutations: [],
    };
    return this.open;
  }

  /** Record + apply one primitive mutation. */
  mutate(m) {
    if (!this.open) throw new Error('no open transaction');
    const applied = this._apply(m);
    this.open.mutations.push(applied);
    return applied;
  }

  commit() {
    if (!this.open) throw new Error('no open transaction');
    const ev = this.open;
    this.open = null;
    if (!ev.mutations.length) return null;
    // Committing after undo truncates the redo tail (standard, and keeps the
    // log a true history of what happened).
    this.events.length = this.cursor;
    this.events.push(ev);
    this.cursor = this.events.length;
    this.nextEventId++;
    this.place.tick = ev.tick;
    this.emit('commit', ev);
    return ev;
  }

  abort() {
    if (!this.open) return;
    const ev = this.open;
    this.open = null;
    for (let i = ev.mutations.length - 1; i >= 0; i--) this._invert(ev.mutations[i]);
    this.emit('abort', ev);
  }

  /** Convenience: run a function inside a transaction. */
  transact(meta, fn) {
    this.begin(meta);
    try {
      const r = fn(this);
      const ev = this.commit();
      return { event: ev, result: r };
    } catch (err) {
      this.abort();
      throw err;
    }
  }

  // ------------------------------------------------------------ primitives --
  _apply(m) {
    const p = this.place;
    switch (m.op) {
      case 'add': {
        const branch = m.branch || p.activeBranch;
        const e = makeEntity(m.entity);
        m.before = clone(p.get(e.id, branch));
        p.put(e, branch);
        m.after = clone(e);
        return m;
      }
      case 'update': {
        const branch = m.branch || p.activeBranch;
        const cur = p.get(m.id, branch);
        if (!cur) throw new Error(`update: no entity ${m.id}`);
        m.before = clone(cur);
        const next = { ...clone(cur), ...clone(m.patch) };
        p.put(next, branch);
        m.after = clone(next);
        return m;
      }
      case 'remove': {
        const branch = m.branch || p.activeBranch;
        m.before = clone(p.get(m.id, branch));
        p.remove(m.id, branch);
        return m;
      }
      case 'relate': {
        p.relations.push({ from: m.from, kind: m.kind, to: m.to, derived: false, author: m.author || null, note: m.note || null });
        return m;
      }
      case 'unrelate': {
        const i = p.relations.findIndex((r) => r.from === m.from && r.kind === m.kind && r.to === m.to);
        m.before = i >= 0 ? clone(p.relations[i]) : null;
        if (i >= 0) p.relations.splice(i, 1);
        return m;
      }
      case 'branch': {
        p.createBranch(m.branchId, { name: m.name, parent: m.parent, note: m.note, author: m.author });
        return m;
      }
      case 'setActiveBranch': {
        m.before = p.activeBranch;
        p.setActiveBranch(m.branchId);
        return m;
      }
      default: throw new Error(`unknown mutation ${m.op}`);
    }
  }

  _invert(m) {
    const p = this.place;
    const branch = m.branch || p.activeBranch;
    switch (m.op) {
      case 'add':
        if (m.before) p.put(clone(m.before), branch); else p.remove(m.after.id, branch);
        break;
      case 'update':
        p.put(clone(m.before), branch);
        break;
      case 'remove':
        if (m.before) p.put(clone(m.before), branch);
        break;
      case 'relate': {
        const i = p.relations.findIndex((r) => r.from === m.from && r.kind === m.kind && r.to === m.to && !r.derived);
        if (i >= 0) p.relations.splice(i, 1);
        break;
      }
      case 'unrelate':
        if (m.before) p.relations.push(clone(m.before));
        break;
      case 'branch': {
        // Undoing the creation of the branch you are standing in must put you
        // somewhere that still exists, or the next mutation writes into a
        // deleted overlay and the world becomes unrecoverable.
        const fallback = m.parent && p.branches.has(m.parent) ? m.parent : 'AS_IS';
        const orphaned = [];
        for (const [id, b] of p.branches) if (b.parent === m.branchId) orphaned.push(id);
        for (const id of orphaned) p.branches.get(id).parent = fallback;
        p.branches.delete(m.branchId);
        p.overlays.delete(m.branchId);
        if (p.activeBranch === m.branchId) p.activeBranch = fallback;
        break;
      }
      case 'setActiveBranch':
        p.setActiveBranch(m.before);
        break;
    }
  }

  // ------------------------------------------------------------ undo/redo ---
  canUndo() { return this.cursor > 0; }
  canRedo() { return this.cursor < this.events.length; }

  undo() {
    if (!this.canUndo()) return null;
    const ev = this.events[--this.cursor];
    for (let i = ev.mutations.length - 1; i >= 0; i--) this._invert(ev.mutations[i]);
    this.place.tick = this.cursor > 0 ? this.events[this.cursor - 1].tick : 0;
    this.emit('undo', ev);
    return ev;
  }

  redo() {
    if (!this.canRedo()) return null;
    const ev = this.events[this.cursor++];
    for (const m of ev.mutations) this._apply(m);
    this.place.tick = ev.tick;
    this.emit('redo', ev);
    return ev;
  }

  // ---------------------------------------------------------- provenance ----
  /** §19 — "why are you here?" answered from the log, not from a debug panel. */
  historyOf(entityId) {
    const out = [];
    for (let i = 0; i < this.cursor; i++) {
      const ev = this.events[i];
      for (const m of ev.mutations) {
        const touches = (m.op === 'add' && m.after?.id === entityId)
          || ((m.op === 'update' || m.op === 'remove') && m.id === entityId)
          || ((m.op === 'relate' || m.op === 'unrelate') && (m.from === entityId || m.to === entityId));
        if (touches) { out.push({ event: ev, mutation: m }); break; }
      }
    }
    return out;
  }

  changedSince(tick, branch = null) {
    const ids = new Set();
    for (let i = 0; i < this.cursor; i++) {
      const ev = this.events[i];
      if (ev.tick <= tick) continue;
      if (branch && ev.branch !== branch) continue;
      for (const m of ev.mutations) {
        if (m.op === 'add') ids.add(m.after.id);
        else if (m.op === 'update' || m.op === 'remove') ids.add(m.id);
      }
    }
    return [...ids];
  }

  toJSON() {
    return { events: this.events.slice(0, this.cursor), cursor: this.cursor, nextEventId: this.nextEventId };
  }
  loadJSON(j) {
    this.events = j.events;
    this.cursor = j.cursor;
    this.nextEventId = j.nextEventId;
  }
}
