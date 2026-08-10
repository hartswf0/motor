// Imported places — real ground, loaded from disk.
//
// Once `node import.js` has run, a place is a plain saved World. Nothing here
// touches the network: the import is a one-off, and everything after it works
// offline, including the test suite.

import { World } from '../core/world.js';

let cache = null;

/** What has been imported. Returns [] when nothing has, which is not an error. */
export async function listImported(base = './places') {
  if (cache) return cache;
  try {
    const res = await fetch(`${base}/index.json`, { cache: 'no-store' });
    if (!res.ok) return (cache = []);
    const list = await res.json();
    return (cache = list.map((p) => ({ ...p, imported: true })));
  } catch {
    return (cache = []);
  }
}

export async function loadImported(key, base = './places') {
  const res = await fetch(`${base}/${key}.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`no imported place "${key}"`);
  return World.load(await res.text());
}

/** Node-side equivalent, for tests and the audit. */
export function loadImportedSync(key, dir) {
  // eslint-disable-next-line
  const { readFileSync } = require('node:fs');
  return World.load(readFileSync(`${dir}/${key}.json`, 'utf8'));
}

/** A line a person can read about where this place came from. */
export function attribution(world) {
  const m = world.place.meta;
  if (!m?.source) return null;
  return `${world.place.name} — ${m.licence}. Fetched ${m.fetchedAt?.slice(0, 10)}. Elevation: ${m.elevation}.`;
}
