// "Take me somewhere" — importing any location from inside the running app.
//
// Nominatim, Overpass and the terrarium tiles all allow browser requests, so
// this needs no server and no key: the deployed page can pull a real
// neighbourhood anywhere in the world and inhabit it.
//
// Imported places are cached in IndexedDB rather than localStorage, because a
// dense European quarter runs to several megabytes and localStorage would throw.

import { importPlace, geocode } from '../import/place.js';
import { parseCoordinates, coordinatePlace } from '../import/geocode.js';
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
  label.textContent = 'Take me anywhere — a name, a coordinate, or a pasted map link';

  const input = document.createElement('input');
  input.className = 'nameInput';
  input.placeholder = 'a street, a village — or 25.7867, -80.1750';
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
    // A coordinate is an answer, not a question: go straight there rather than
    // asking a geocoder to guess which "25.7867" was meant.
    const at = parseCoordinates(q);
    if (at) {
      say(`${at.label} — read as ${at.how}`);
      const b = document.createElement('button');
      b.innerHTML = `Go to ${escapeHTML(at.label)}<span class="sub">exact coordinate · 900 m around it</span>`;
      b.onclick = () => pull(coordinatePlace(at, 900));
      results.append(b);
      searching = false;
      return;
    }
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
      toast(world.place.meta?.sparse
        ? `${name} — nothing is mapped here yet. The ground is real: ${world.place.meta?.relief || 0} m of relief. Draw and say what belongs.`
        : `${name} — ${stats.buildings} buildings, ${stats.roads + stats.paths} ways, ${world.place.meta?.relief || 0} m relief.`);
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

/**
 * WIDEN, OR MOVE THE WINDOW.
 *
 * A window is a guess made before you have seen anything. You arrive, and the
 * thing you came for runs off the edge — the river continues, the site is half
 * in — and until now the only remedy was to search again from scratch and lose
 * the place you were standing in.
 *
 * The place remembers the corner of the world it was cut from, so where the
 * camera is looking can be turned back into a latitude and longitude and a new,
 * larger window cut around THAT. Nothing is guessed: the same import runs
 * again, on real ground, from the point you were actually looking at.
 */
export function reframe(world, { camera, metres, log = () => {} }) {
  const bbox = world.place.meta?.bbox;
  if (!bbox) throw new Error('this place does not remember where in the world it is');
  const [south, west, north, east] = bbox;
  const midLat = (south + north) / 2;

  // the local grid is metres east and north of the window's centre
  const b = world.place.terrain?.bounds || world.place.bounds();
  const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  const dx = (camera?.target?.[0] ?? cx) - cx;
  const dy = (camera?.target?.[1] ?? cy) - cy;

  const lat = (south + north) / 2 + dy / 111320;
  const lon = (west + east) / 2 + dx / (111320 * Math.max(0.05, Math.cos((midLat * Math.PI) / 180)));

  const dLat = metres / 2 / 111320;
  const dLon = metres / 2 / (111320 * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  log(`re-cutting ${metres} m around ${Math.abs(lat).toFixed(5)}°${lat < 0 ? 'S' : 'N'} ${Math.abs(lon).toFixed(5)}°${lon < 0 ? 'W' : 'E'}`);
  return { bbox: [lat - dLat, lon - dLon, lat + dLat, lon + dLon], lat, lon, metres };
}

/** The panel: how much more ground, and around what. */
export function openReframePanel({ anchorEl, world, camera, currentMetres = 900, onLoaded, toast }) {
  document.querySelector('.importPanel')?.remove();
  const panel = document.createElement('div');
  panel.className = 'menu importPanel';
  const r = anchorEl.getBoundingClientRect();
  panel.style.left = `${Math.max(8, r.left)}px`;
  panel.style.top = `${r.bottom + 8}px`;
  panel.style.width = 'min(380px, calc(100vw - 24px))';

  const label = document.createElement('div');
  label.className = 'menuLabel';
  label.textContent = 'Show more ground, around where you are looking';
  const status = document.createElement('div');
  status.className = 'importStatus';
  const results = document.createElement('div');
  panel.append(label, status, results);
  document.body.append(panel);

  const say = (m) => { status.textContent = m; };
  say(`this window is about ${Math.round(currentMetres)} m across`);

  for (const metres of [currentMetres * 1.5, currentMetres * 2.5, currentMetres * 4].map((m) => Math.round(m / 100) * 100)) {
    const b = document.createElement('button');
    b.innerHTML = `${metres} m across<span class="sub">${(metres / currentMetres).toFixed(1)}× this window, centred where you are looking</span>`;
    b.onclick = () => pull(metres);
    results.append(b);
  }
  const same = document.createElement('button');
  same.innerHTML = `Move the window here<span class="sub">same ${Math.round(currentMetres)} m, re-centred on your view</span>`;
  same.onclick = () => pull(Math.round(currentMetres));
  results.append(same);

  async function pull(metres) {
    results.replaceChildren();
    const lines = [];
    const log = (m) => { lines.push(m); say(lines.slice(-2).join(' · ')); };
    try {
      const { bbox } = reframe(world, { camera, metres, log });
      const base = (world.place.name || 'here').split(' — ')[0];
      const { world: next, key, name, stats } = await importPlace({
        bbox, name: `${base} · ${metres} m`, metres, log,
      });
      say('saving…');
      await cachePut(key, {
        payload: next.save(),
        meta: {
          key, name, counts: stats,
          relief: next.place.meta?.relief || 0,
          bbox: next.place.meta?.bbox,
          fetchedAt: next.place.meta?.fetchedAt,
          source: 'OpenStreetMap (ODbL)',
        },
      });
      panel.remove();
      onLoaded(next, key, name);
      toast(`${metres} m across — ${stats.buildings || 0} buildings, ${next.place.meta?.relief || 0} m relief.`);
    } catch (err) {
      say(String(err.message).slice(0, 160));
    }
  }

  setTimeout(() => document.addEventListener('pointerdown', function off(e) {
    if (!panel.contains(e.target)) { panel.remove(); document.removeEventListener('pointerdown', off); }
  }), 0);
  return panel;
}
