// "Take me somewhere" — importing any location from inside the running app.
//
// Nominatim, Overpass and the terrarium tiles all allow browser requests, so
// this needs no server and no key: the deployed page can pull a real
// neighbourhood anywhere in the world and inhabit it.
//
// Imported places are cached in IndexedDB rather than localStorage, because a
// dense European quarter runs to several megabytes and localStorage would throw.

import { importPlace, geocode } from '../import/place.js';
import { World } from '../core/world.js';

const DB = 'creo-places';
const STORE = 'worlds';

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function idb(mode, fn) {
  try {
    const db = await open();
    return await new Promise((res, rej) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  } catch { return null; }
}

export const cachePut = (key, value) => idb('readwrite', (s) => s.put(value, key));
export const cacheGet = (key) => idb('readonly', (s) => s.get(key));
export const cacheKeys = () => idb('readonly', (s) => s.getAllKeys());

/** Places the user has pulled in during this or an earlier session. */
export async function listCached() {
  const keys = (await cacheKeys()) || [];
  const out = [];
  for (const k of keys) {
    const rec = await cacheGet(k);
    if (rec?.meta) out.push({ ...rec.meta, key: k, cached: true });
  }
  return out;
}

export async function loadCached(key) {
  const rec = await cacheGet(key);
  if (!rec) throw new Error(`not cached: ${key}`);
  return World.load(rec.payload);
}

/**
 * The search panel. Deliberately two-step: a name is often ambiguous, and
 * silently picking the first Springfield is the kind of guess this project
 * refuses everywhere else.
 */
export function openImportPanel({ anchorEl, onLoaded, toast }) {
  document.querySelector('.importPanel')?.remove();
  const panel = document.createElement('div');
  panel.className = 'menu importPanel';
  const r = anchorEl.getBoundingClientRect();
  panel.style.left = `${Math.max(8, r.left)}px`;
  panel.style.top = `${r.bottom + 8}px`;
  panel.style.width = 'min(380px, calc(100vw - 24px))';

  const label = document.createElement('div');
  label.className = 'menuLabel';
  label.textContent = 'Take me anywhere — any street, district or village';

  const input = document.createElement('input');
  input.className = 'nameInput';
  input.placeholder = 'e.g. Kibera Nairobi · Jordaan Amsterdam · your street';
  input.setAttribute('aria-label', 'Search for a place');

  const status = document.createElement('div');
  status.className = 'importStatus';

  const results = document.createElement('div');

  panel.append(label, input, status, results);
  document.body.append(panel);
  input.focus();

  const say = (m) => { status.textContent = m; };

  let searching = false;
  async function search() {
    const q = input.value.trim();
    if (!q || searching) return;
    searching = true;
    results.replaceChildren();
    say('searching…');
    try {
      const hits = await geocode(q, { limit: 6 });
      if (!hits.length) { say(`nothing found for “${q}”`); searching = false; return; }
      say(hits.length === 1 ? 'one match' : `${hits.length} matches — which one?`);
      for (const h of hits) {
        const b = document.createElement('button');
        b.innerHTML = `${escapeHTML(h.short)}<span class="sub">${h.kind.replace('/', ' · ')} — ${h.span.width}×${h.span.height} m</span>`;
        b.onclick = () => pull(h);
        results.append(b);
      }
    } catch (err) {
      say(`the geocoder is unavailable (${String(err.message).slice(0, 60)})`);
    }
    searching = false;
  }

  async function pull(hit) {
    results.replaceChildren();
    input.disabled = true;
    const lines = [];
    const log = (m) => { lines.push(m); say(lines.slice(-2).join(' · ')); };
    try {
      const { world, key, name, stats } = await importPlace({
        query: hit.short, bbox: hit.bbox, name: hit.short, metres: 900, log,
      });
      say('saving…');
      const payload = world.save();
      await cachePut(key, {
        payload,
        meta: {
          key, name, counts: stats,
          relief: world.place.meta?.relief || 0,
          bbox: world.place.meta?.bbox,
          fetchedAt: world.place.meta?.fetchedAt,
          source: 'OpenStreetMap (ODbL)',
        },
      });
      panel.remove();
      onLoaded(world, key, name);
      toast(`${name} — ${stats.buildings} buildings, ${stats.roads + stats.paths} ways, ${world.place.meta?.relief || 0} m relief.`);
    } catch (err) {
      input.disabled = false;
      say(String(err.message).slice(0, 160));
    }
  }

  input.onkeydown = (e) => { if (e.key === 'Enter') search(); if (e.key === 'Escape') panel.remove(); };

  setTimeout(() => document.addEventListener('pointerdown', function off(e) {
    if (!panel.contains(e.target)) { panel.remove(); document.removeEventListener('pointerdown', off); }
  }), 0);

  return panel;
}

const escapeHTML = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
