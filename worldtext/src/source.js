// SOURCE IR — the corpus is sacred (§3).
//
// Exact language, stable identity, never replaced by extraction. Everything the
// motor later believes must be able to point back to a passage here and quote it
// verbatim. Summaries and indexes are caches over this; this is not a cache over
// anything.

/** Stable, content-addressed-ish ids: same document, same text → same id. */
function hash(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

export class Corpus {
  constructor() {
    this.documents = new Map();      // docId -> {id, title, kind, meta}
    this.passages = new Map();       // passageId -> Passage
    this.order = [];                 // passageIds in reading order
  }

  /**
   * @param {{id?:string, title:string, kind?:string, speaker?:string, meta?:object}} doc
   * @param {string} text
   */
  add(doc, text) {
    const id = doc.id || `doc_${hash(doc.title)}`;
    this.documents.set(id, {
      id, title: doc.title, kind: doc.kind || 'text',
      speaker: doc.speaker || null, meta: doc.meta || {},
      addedAtIndex: this.order.length,
    });
    let index = 0;
    for (const unit of segment(text)) {
      const pid = `${id}:${String(index).padStart(4, '0')}`;
      const passage = {
        id: pid,
        docId: id,
        index,
        text: unit.text,                       // EXACT source language
        heading: unit.heading,
        speaker: unit.speaker || doc.speaker || null,
        offset: unit.offset,
        meta: { ...doc.meta },
      };
      this.passages.set(pid, passage);
      this.order.push(pid);
      index++;
    }
    return id;
  }

  get(id) { return this.passages.get(id) || null; }
  doc(id) { return this.documents.get(id) || null; }
  all() { return this.order.map((id) => this.passages.get(id)); }
  size() { return this.passages.size; }

  /** Quote a passage exactly, with its citation. Used everywhere provenance is shown. */
  quote(id) {
    const p = this.get(id);
    if (!p) return null;
    const d = this.doc(p.docId);
    return {
      text: p.text,
      citation: `${d.title}${p.heading ? `, ${p.heading}` : ''} §${p.index}`,
      speaker: p.speaker,
      docKind: d.kind,
      passageId: id,
    };
  }

  /** Plain lexical search over the exact source. No embeddings, no model. */
  search(query, limit = 12) {
    const terms = String(query).toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
    if (!terms.length) return [];
    const scored = [];
    for (const p of this.all()) {
      const hay = p.text.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (t.length < 3) continue;
        let at = hay.indexOf(t);
        while (at >= 0) { score += 1; at = hay.indexOf(t, at + t.length); }
      }
      if (score > 0) scored.push({ passage: p, score: score / Math.sqrt(p.text.length) });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  toJSON() {
    return {
      documents: [...this.documents.values()],
      passages: this.order.map((id) => this.passages.get(id)),
    };
  }

  static fromJSON(j) {
    const c = new Corpus();
    for (const d of j.documents) c.documents.set(d.id, d);
    for (const p of j.passages) { c.passages.set(p.id, p); c.order.push(p.id); }
    return c;
  }
}

/**
 * Split a document into passages: sentence-ish units that keep their heading and
 * speaker attribution. Deliberately conservative — a passage that cannot be split
 * safely stays whole rather than being mangled.
 */
export function segment(text) {
  const out = [];
  let heading = null;
  let offset = 0;
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.trim();
    if (!line) { offset += rawLine.length + 1; continue; }

    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) { heading = h[1].trim(); offset += rawLine.length + 1; continue; }

    // "MARTA: the mill closed in 1984" — testimony keeps its speaker
    const sp = /^([A-Z][A-Za-z' -]{1,30}):\s+(.*)$/.exec(line);
    const speaker = sp ? sp[1].trim() : null;
    const body = sp ? sp[2] : line;

    for (const s of splitSentences(body)) {
      out.push({ text: s, heading, speaker, offset });
      offset += s.length;
    }
    offset += 1;
  }
  return out;
}

const ABBREV = /\b(mr|mrs|ms|dr|st|prof|no|vs|etc|approx|fig|ch)\.$/i;

function splitSentences(s) {
  const parts = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    buf += s[i];
    if (!'.!?'.includes(s[i])) continue;
    const next = s[i + 1];
    if (next && !/[\s"'”’)]/.test(next)) continue;   // 1.5, e.g.
    if (ABBREV.test(buf.trim())) continue;
    const t = buf.trim();
    if (t) parts.push(t);
    buf = '';
  }
  const tail = buf.trim();
  if (tail) parts.push(tail);
  return parts.length ? parts : [s.trim()].filter(Boolean);
}
