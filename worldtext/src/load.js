// Loading a world is: read text, index it, discover potentials. Nothing else.

import { readFileSync, readdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { WorldText, resetIds } from './worldtext.js';
import { index } from './parse.js';
import { discover } from './potential.js';

const KIND_BY_HEADING = {
  testimony: 'testimony',
  register: 'archive',
  'field notes': 'field-notes',
  archive: 'archive',
};

/** Load one text into a fresh world. Splits on top-level headings into documents. */
export function loadText(text, title = 'untitled') {
  resetIds(0);
  const world = new WorldText();
  addText(world, text, title);
  const report = index(world);
  const potentials = discover(world);
  return { world, report, potentials };
}

export function addText(world, text, title = 'untitled') {
  const sections = splitSections(text, title);
  for (const s of sections) {
    world.corpus.add({ title: s.title, kind: s.kind, speaker: null }, s.body);
  }
  return sections.length;
}

export function loadDir(dir) {
  resetIds(0);
  const world = new WorldText();
  for (const f of readdirSync(dir).sort()) {
    if (!['.md', '.txt'].includes(extname(f))) continue;
    addText(world, readFileSync(join(dir, f), 'utf8'), basename(f, extname(f)));
  }
  const report = index(world);
  const potentials = discover(world);
  return { world, report, potentials };
}

function splitSections(text, title) {
  const lines = text.split('\n');
  const sections = [];
  let cur = { title, kind: 'text', lines: [] };
  for (const line of lines) {
    const m = /^#\s+(.+)$/.exec(line.trim());
    if (m) {
      if (cur.lines.some((l) => l.trim())) sections.push(cur);
      const name = m[1].trim();
      cur = { title: `${title} — ${name}`, kind: KIND_BY_HEADING[name.toLowerCase()] || 'text', lines: [] };
      continue;
    }
    cur.lines.push(line);
  }
  if (cur.lines.some((l) => l.trim())) sections.push(cur);
  return sections.map((s) => ({ ...s, body: s.lines.join('\n') }));
}
