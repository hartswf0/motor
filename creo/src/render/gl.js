// THE WORLD, DRAWN.
//
// A small WebGL2 renderer that reads the PlaceModel directly. It has no scene
// graph of its own — there is nothing here that could drift from the model. Its
// only job is to make the place legible: what is real, what is proposed, what is
// in conflict, and what changed.

import * as G from '../core/geom.js';

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec4 aColor;
uniform mat4 uViewProj;
uniform vec3 uSun;
out vec4 vColor;
out float vFog;
out vec3 vWorld;
void main() {
  vec4 clip = uViewProj * vec4(aPos, 1.0);
  gl_Position = clip;
  float lambert = max(dot(normalize(aNormal), normalize(uSun)), 0.0);
  float ambient = 0.66 + 0.14 * aNormal.z;
  vColor = vec4(aColor.rgb * (ambient + 0.46 * lambert), aColor.a);
  vFog = clamp(clip.w / 900.0, 0.0, 1.0);
  vWorld = aPos;
}`;

const FRAG = `#version 300 es
precision highp float;
in vec4 vColor;
in float vFog;
in vec3 vWorld;
uniform vec4 uFog;
out vec4 outColor;
void main() {
  vec3 c = mix(vColor.rgb, uFog.rgb, vFog * 0.85);
  outColor = vec4(c, vColor.a);
}`;

const LINE_VERT = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aColor;
uniform mat4 uViewProj;
out vec4 vColor;
void main() { gl_Position = uViewProj * vec4(aPos, 1.0); vColor = aColor; }`;

const LINE_FRAG = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() { outColor = vColor; }`;

// Palette: the world is the subject, the interface is not.
export const PALETTE = {
  ground: [0.36, 0.35, 0.30],
  groundHigh: [0.47, 0.45, 0.38],
  structure: [0.62, 0.58, 0.52],
  roof: [0.52, 0.46, 0.41],
  iron: [0.55, 0.42, 0.36],
  room: [0.70, 0.68, 0.63],
  wall: [0.58, 0.56, 0.52],
  road: [0.30, 0.29, 0.28],
  path: [0.46, 0.43, 0.38],
  drain: [0.25, 0.36, 0.44],
  water: [0.20, 0.42, 0.56],
  waterEdge: [0.44, 0.78, 0.98],
  tree: [0.28, 0.44, 0.26],
  treeTrunk: [0.30, 0.25, 0.20],
  surface: [0.40, 0.44, 0.31],
  market: [0.64, 0.52, 0.34],
  bench: [0.50, 0.40, 0.30],
  light: [0.72, 0.70, 0.60],
  observation: [0.95, 0.72, 0.25],
  disputed: [0.90, 0.45, 0.30],
  contour: [0.98, 0.94, 0.82],
  contourIndex: [1.00, 0.86, 0.52],
  bridge: [0.60, 0.55, 0.48],
  furniture: [0.62, 0.55, 0.45],
  opening: [0.85, 0.90, 0.95],
  parcel: [0.40, 0.40, 0.36],
  car: [0.45, 0.48, 0.52],
  ghost: [0.35, 0.85, 0.75],
  ghostBad: [0.95, 0.42, 0.38],
  select: [1.0, 0.95, 0.55],
  highlight: [0.45, 0.85, 1.0],
  preserve: [0.55, 0.95, 0.60],
  sky: [0.055, 0.063, 0.078],
};

const TYPE_COLOR = {
  structure: 'structure', room: 'room', wall: 'wall', road: 'road', path: 'path',
  drain: 'drain', stream: 'water', water: 'water', tree: 'tree', surface: 'surface',
  market: 'market', bench: 'bench', light: 'light', observation: 'observation',
  bridge: 'bridge', furniture: 'furniture', opening: 'opening', parcel: 'parcel', car: 'car',
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 is required');
    this.gl = gl;
    this.prog = link(gl, VERT, FRAG);
    this.lineProg = link(gl, LINE_VERT, LINE_FRAG);
    this.solid = makeMesh(gl, 3);
    this.trans = makeMesh(gl, 3);
    this.lines = makeLineMesh(gl);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    this.fidelity = 'high';
    this.dprCap = 2;
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, this.dprCap ?? 2);
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
    return [w, h];
  }

  /**
   * Rebuild geometry from the model. Called when the world changes — not per
   * frame — so a thousand entities cost nothing to look at.
   */
  build(world, opts = {}) {
    const { ghosts = [], selection = new Set(), highlight = new Set(), overlay = null,
            preserved = new Set(), changed = new Set(), fidelity = 'high', hour = 14,
            cutawayAt = null, hidden = new Set(), metresPerPixel = 0.25 } = opts;
    this.fidelity = fidelity;
    const S = new Builder();        // opaque
    const T = new Builder();        // translucent
    const L = new LineBuilder();

    if (world.place.terrain && fidelity !== 'symbolic') this.buildTerrain(S, world, overlay, fidelity);
    this.contourInterval = 0;
    if (world.place.terrain && fidelity !== 'symbolic' && opts.contours !== false) {
      this.buildContours(L, world, fidelity);
    }

    const ents = world.entities();
    const detail = { high: 0, medium: 1, low: 2, symbolic: 3 }[fidelity];

    // Draping needs the ground and a sensible piece size. The terrain's own
    // sample spacing is the right scale: finer invents detail the data does not
    // have, coarser is what put roads inside hillsides in the first place.
    // THE GROUND THAT IS DRAWN, not the ground that is computed.
    //
    // groundAt is bilinear — a curved surface. The terrain mesh is flat
    // triangles. They agree only at the sample points, and everywhere between
    // them the drawn hill rides above the curve, swallowing anything laid on it.
    // At full detail that buried a fifth of Boone's road vertices; zoomed out,
    // where the mesh skips samples entirely, it buried more than half of them by
    // up to 9.7 m. Simulation still asks the smooth surface — that is the truth
    // about the ground — but what is laid ON the ground must answer to what is
    // shown, or a road disappears into a hillside that is not really there.
    const terrainStep = { high: 1, medium: 2, low: 3 }[fidelity] || 1;
    const ground = (x, y) => drawnGroundAt(world.place.terrain, x, y, terrainStep);

    // Half the DEM's own cell: bilinear ground sampling makes the midpoints
    // real, so this reads the elevation data more finely without inventing
    // detail it does not contain. Measured on Ravello, halving the piece takes
    // the worst deviation from 6.0 m to 3.0 m. Coarser when drawing cheaply.
    // Tile on the terrain's OWN lattice, split on its OWN diagonal: each piece
    // then lies inside a single drawn triangle, where the ground is genuinely
    // one plane, and the drape coincides with it exactly.
    const terr = world.place.terrain;
    const cell = terr ? terr.cell * terrainStep : 12;
    const grid = terr ? [terr.bounds[0], terr.bounds[1]] : null;
    // A thing that lies on the ground is at the ground, plus a hair to stop it
    // fighting the terrain for the same pixels. Do NOT reconstruct this from the
    // stored zTop: surfaces were authored against their centroid and roads
    // against their first vertex, so on a hillside that difference IS the error
    // — it drew an 86,000 m² wood twenty-one metres up in the air.
    const flatOffset = (e) => FLAT_ORDER[e.type] ?? FLAT_ORDER.default;

    for (const e of ents) {
      if (hidden.has(e.type)) continue;          // a layer the person turned off
      if (!visibleAt(e, detail)) continue;
      const ring = world.ringOf(e);
      if (!ring || ring.length < 3) continue;
      const col = colorFor(e);
      const sel = selection.has(e.id);
      const hi = highlight.has(e.id);

      if (e.type === 'tree') {
        this.buildTree(S, e, ring, detail);
      } else if (e.type === 'observation') {
        // What someone said about a place should mark it, not bury it. An
        // opaque fill over a drawn area hid the very thing being discussed.
        T.draped(ring, ground, flatOffset(e) + 0.02, col, 0.18, cell, grid);
        L.ring(ring, e.zTop + 0.06, col, 0.95);
        this.buildPin(S, L, e, ring);
      } else if (e.type === 'water' || e.type === 'stream') {
        // A creek is three metres across. From three hundred metres up that is a
        // third of a pixel, which is why the water has been invisible: it was
        // being drawn correctly and drawn to nothing. Every map ever printed
        // solves this the same way — draw the water wider than it is until its
        // real width can carry itself, and outline it so the eye finds it at any
        // distance. The widening is for the eye only; every query and every
        // certificate still uses the true ring.
        const ob = G.orientedBounds(ring);
        const narrow = Math.min(ob.width, ob.depth);
        const wantAcross = metresPerPixel * 5;
        const drawn = narrow < wantAcross
          ? G.offsetRing(ring, Math.min(12, (wantAcross - narrow) / 2))
          : ring;
        S.draped(drawn, ground, flatOffset(e), col, 1, cell, grid);
        // the edge is what makes it findable when it is one pixel wide
        L.ring(drawn, 0, PALETTE.waterEdge, 0.9, ground, flatOffset(e) + 0.05);
      } else if (isFlat(e)) {
        S.draped(ring, ground, flatOffset(e), col, 1, cell, grid);
      } else {
        // Standing inside a building, the roof is the one thing you do not want
        // to look at. What matters changes with where you are (§17).
        const cutaway = cutawayAt && e.type === 'structure' && G.pointInRing(cutawayAt, ring);
        const shape = e.props?.roof?.shape;
        const wantsRoof = !cutaway && e.type === 'structure' && detail <= 1 && shape && shape !== 'flat';
        if (wantsRoof) {
          const rh = roofHeightFor(e, ring);
          const eaves = Math.max(e.zBase + 0.4, e.zTop - rh);
          S.prism(ring, e.zBase, eaves, col, col, 1, false);
          S.roof(ring, eaves, eaves + rh, shape, roofColorFor(e));
        } else {
          S.prism(ring, e.zBase, e.zTop, col, roofColorFor(e), 1, !cutaway);
        }
        if (cutaway) L.ring(ring, e.zTop, [1, 1, 1], 0.28);
      }

      if (sel) L.ring(ring, e.zTop + 0.06, PALETTE.select, 1);
      else if (hi) L.ring(ring, e.zTop + 0.06, PALETTE.highlight, 1);
      else if (preserved.has(e.id)) L.ring(ring, e.zTop + 0.05, PALETTE.preserve, 0.85);
      else if (changed.has(e.id)) L.ring(ring, e.zTop + 0.05, [0.6, 0.8, 1.0], 0.5);
      else if (e.epistemic === 'DISPUTED') L.ring(ring, e.zTop + 0.05, PALETTE.disputed, 0.9);
      else if (detail === 0 && (e.type === 'structure' || e.type === 'room')) L.ring(ring, e.zTop + 0.02, [0, 0, 0], 0.22);
    }

    // ghosts: unmistakably not yet real
    for (const g of ghosts) {
      const ring = world.place.ringOf(g);
      if (!ring || ring.length < 3) continue;
      const bad = g.__invalid;
      const col = bad ? PALETTE.ghostBad : PALETTE.ghost;
      if (isFlat(g)) T.draped(ring, ground, flatOffset(g) + 0.04, col, 0.42, cell, grid);
      else T.prism(ring, g.zBase, g.zTop, col, col, 0.38);
      L.ring(ring, g.zTop + 0.08, col, 1);
      L.ring(ring, g.zBase + 0.02, col, 0.5);
      for (const p of ring) L.segment([p[0], p[1], g.zBase], [p[0], p[1], g.zTop], col, 0.5);
    }

    if (overlay) this.buildOverlay(T, L, world, overlay);

    this.solid.upload(S);
    this.trans.upload(T);
    this.lines.upload(L);
    this.stats = { entities: ents.length, tris: S.count / 3 + T.count / 3 };
    return this.stats;
  }

  buildTerrain(B, world, overlay, fidelity) {
    // NOTE: the split below (00,10,11) + (00,11,01) is the one drawnGroundAt
    // reproduces. Change one and you must change the other, or things laid on
    // the ground start sinking into it again.
    const t = world.place.terrain;
    const step = fidelity === 'low' ? 3 : (fidelity === 'medium' ? 2 : 1);
    const water = overlay?.kind === 'water' ? overlay.water : null;
    for (let j = 0; j + step < t.ny; j += step) {
      for (let i = 0; i + step < t.nx; i += step) {
        const x0 = t.bounds[0] + i * t.cell, y0 = t.bounds[1] + j * t.cell;
        const x1 = t.bounds[0] + (i + step) * t.cell, y1 = t.bounds[1] + (j + step) * t.cell;
        const h00 = t.at(i, j), h10 = t.at(i + step, j), h01 = t.at(i, j + step), h11 = t.at(i + step, j + step);
        const c = terrainColor((h00 + h11) / 2, t, water, (x0 + x1) / 2, (y0 + y1) / 2);
        B.quad([x0, y0, h00], [x1, y0, h10], [x1, y1, h11], [x0, y1, h01], c, 1);
      }
    }
  }

  /**
   * CONTOURS — the one drawing convention that makes ground legible.
   *
   * A shaded surface tells you where the light is, not where the hill is. On
   * 281 m of relief a hillside reads as a flat wash, and no one can judge a site
   * from it. Contours give the eye something to count: spacing IS steepness,
   * closed rings ARE summits and hollows, and both survive any camera angle.
   *
   * The interval is chosen from the actual relief so a flat delta gets metre
   * lines and a mountain gets fifties, and every fifth line is drawn heavier —
   * the index contour, which is how a map is read.
   */
  buildContours(L, world, fidelity) {
    const t = world.place.terrain;
    if (!t) return;
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < t.data.length; k++) {
      const v = t.data[k];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const relief = hi - lo;
    if (!isFinite(relief) || relief < 1.5) return;      // nothing to say about a plain

    // roughly 25 lines across whatever relief this place has, rounded to a
    // number a person reads without effort
    const raw = relief / 25;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const interval = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= raw) || 10 * pow;
    const step = fidelity === 'low' ? 2 : 1;

    // Marching squares, but on the TRIANGLES THE MESH DRAWS rather than on the
    // cell as a quad. A quad's four corners describe a curved surface; the mesh
    // draws two flat triangles. Contour a curve and draw a facet and the line
    // crosses in and out of the ground — a fifth of the contour length on
    // Watauga Lake was inside the hill, by up to 4.6 m, which is why the lines
    // came out dashed on the steep faces.
    //
    // Inside a single flat triangle the level set is a straight segment lying
    // exactly on the surface, so this is not an improvement in accuracy but a
    // removal of the disagreement: the contour is on the ground by construction.
    const first = Math.ceil(lo / interval) * interval;
    const seg = (tri, level, col, alpha) => {
      const hit = [];
      for (let k = 0; k < 3; k++) {
        const a = tri[k], b = tri[(k + 1) % 3];
        if ((a[2] < level) === (b[2] < level)) continue;
        const f = (level - a[2]) / (b[2] - a[2]);
        hit.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      }
      if (hit.length !== 2) return;
      L.segment([hit[0][0], hit[0][1], level + 0.12], [hit[1][0], hit[1][1], level + 0.12], col, alpha);
    };

    for (let level = first; level <= hi; level += interval) {
      const isIndex = Math.abs((level / interval) % 5) < 0.001;
      const col = isIndex ? PALETTE.contourIndex : PALETTE.contour;
      const alpha = isIndex ? 0.85 : 0.42;
      for (let j = 0; j + step < t.ny; j += step) {
        for (let i = 0; i + step < t.nx; i += step) {
          const x0 = t.bounds[0] + i * t.cell, y0 = t.bounds[1] + j * t.cell;
          const x1 = t.bounds[0] + (i + step) * t.cell, y1 = t.bounds[1] + (j + step) * t.cell;
          const p00 = [x0, y0, t.at(i, j)];
          const p10 = [x1, y0, t.at(i + step, j)];
          const p11 = [x1, y1, t.at(i + step, j + step)];
          const p01 = [x0, y1, t.at(i, j + step)];
          // the same two triangles buildTerrain emits, in the same order
          seg([p00, p10, p11], level, col, alpha);
          seg([p00, p11, p01], level, col, alpha);
        }
      }
    }
    this.contourInterval = interval;
  }

  buildTree(B, e, ring, detail) {
    const c = G.centroid(ring);
    const r = e.props?.canopyRadius || 2.5;
    const top = e.zTop, base = e.zBase;
    if (detail >= 2) { B.polygon(ring, base + 0.05, PALETTE.tree, 1); return; }
    B.prism(G.circleRing(c[0], c[1], r * 0.14, 6), base, base + (top - base) * 0.45, PALETTE.treeTrunk, PALETTE.treeTrunk);
    const canopyBase = base + (top - base) * 0.4;
    const seg = detail === 0 ? 10 : 6;
    B.cone(c, r, canopyBase, top, PALETTE.tree, seg);
  }

  buildPin(B, L, e, ring) {
    const c = G.centroid(ring);
    const h = e.zTop + 2.6;
    L.segment([c[0], c[1], e.zTop], [c[0], c[1], h], PALETTE.observation, 1);
    B.prism(G.circleRing(c[0], c[1], 0.45, 8), h, h + 0.9, PALETTE.observation, PALETTE.observation);
  }

  buildOverlay(T, L, world, overlay) {
    if (overlay.kind === 'water' && overlay.water) {
      const w = overlay.water;
      for (let j = 0; j < w.ny; j++) {
        for (let i = 0; i < w.nx; i++) {
          const d = w.depth[j * w.nx + i];
          // A film a centimetre deep is not what anyone means by flooding, and
          // painting it made the whole place read as a dark wash.
          if (d <= 0.05) continue;
          const x = w.bounds[0] + i * w.cell, y = w.bounds[1] + j * w.cell;
          const z = w.elev[j * w.nx + i] + d;
          const t = Math.min(1, d / 0.5);
          // shallow reads pale and thin, deep reads saturated — depth you can see
          const col = [
            0.42 - 0.30 * t,
            0.72 - 0.36 * t,
            0.92 - 0.20 * t,
          ];
          T.quad([x, y, z], [x + w.cell, y, z], [x + w.cell, y + w.cell, z], [x, y + w.cell, z], col, 0.30 + 0.45 * t);
        }
      }
    }
    if (overlay.kind === 'shade') {
      for (const p of overlay.unshaded || []) {
        const z = world.place.groundAt(p[0], p[1]) + 0.04;
        T.quad([p[0] - 0.7, p[1] - 0.7, z], [p[0] + 0.7, p[1] - 0.7, z], [p[0] + 0.7, p[1] + 0.7, z], [p[0] - 0.7, p[1] + 0.7, z], [0.95, 0.75, 0.35], 0.30);
      }
    }
    if (overlay.kind === 'dark') {
      for (const p of overlay.points || []) {
        const z = world.place.groundAt(p[0], p[1]) + 0.04;
        T.quad([p[0] - 1, p[1] - 1, z], [p[0] + 1, p[1] - 1, z], [p[0] + 1, p[1] + 1, z], [p[0] - 1, p[1] + 1, z], [0.2, 0.25, 0.5], 0.5);
      }
    }
    if (overlay.kind === 'fits') {
      for (const ring of overlay.rings || []) {
        const z = world.place.groundAt(...G.centroid(ring)) + 0.06;
        T.polygon(ring, z, PALETTE.preserve, 0.20);
        L.ring(ring, z + 0.01, PALETTE.preserve, 0.7);
      }
    }
    if (overlay.kind === 'probe') {
      const z = world.place.groundAt(...G.centroid(overlay.ring)) + 0.08;
      T.polygon(overlay.ring, z, overlay.ok ? PALETTE.preserve : PALETTE.ghostBad, 0.3);
      L.ring(overlay.ring, z + 0.01, overlay.ok ? PALETTE.preserve : PALETTE.ghostBad, 1);
      if (overlay.alternative) L.ring(overlay.alternative, z + 0.01, PALETTE.preserve, 0.9);
    }
    for (const corr of overlay.corridors || []) {
      const z = corr.zBase ?? 0;
      T.polygon(corr.ring, z + 0.05, [0.95, 0.9, 0.6], 0.16);
      L.ring(corr.ring, z + 0.06, [0.95, 0.9, 0.6], 0.6);
    }
    for (const tr of overlay.trace || []) {
      for (let i = 0; i < tr.length - 1; i++) {
        const a = tr[i], b = tr[i + 1];
        L.segment([a[0], a[1], world.place.groundAt(a[0], a[1]) + 0.4], [b[0], b[1], world.place.groundAt(b[0], b[1]) + 0.4], PALETTE.highlight, 1);
      }
    }
    if (overlay.stroke) {
      const s = overlay.stroke;
      if (overlay.strokeClosed && s.length > 2) {
        T.polygon(s, world.place.groundAt(...G.centroid(s)) + 0.1, PALETTE.select, 0.14);
      }
      for (let i = 0; i < s.length - 1; i++) {
        L.segment([s[i][0], s[i][1], world.place.groundAt(...s[i]) + 0.12],
                  [s[i + 1][0], s[i + 1][1], world.place.groundAt(...s[i + 1]) + 0.12], PALETTE.select, 1);
      }
      if (overlay.strokeClosed && s.length > 2) {
        L.segment([s[s.length - 1][0], s[s.length - 1][1], world.place.groundAt(...s[s.length - 1]) + 0.12],
                  [s[0][0], s[0][1], world.place.groundAt(...s[0]) + 0.12], PALETTE.select, 1);
      }
    }
  }

  draw(viewProj, sun = [0.4, -0.6, 0.9]) {
    const gl = this.gl;
    const [w, h] = this.resize();
    gl.clearColor(PALETTE.sky[0], PALETTE.sky[1], PALETTE.sky[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.prog, 'uViewProj'), false, viewProj);
    gl.uniform3fv(gl.getUniformLocation(this.prog, 'uSun'), sun);
    gl.uniform4f(gl.getUniformLocation(this.prog, 'uFog'), PALETTE.sky[0], PALETTE.sky[1], PALETTE.sky[2], 1);

    gl.disable(gl.BLEND);
    gl.depthMask(true);
    this.solid.draw(gl);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    this.trans.draw(gl);
    gl.enable(gl.CULL_FACE);

    gl.useProgram(this.lineProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.lineProg, 'uViewProj'), false, viewProj);
    this.lines.draw(gl);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
}

function visibleAt(e, detail) {
  // ZOOM CHANGES WHAT MATTERS (§17): scale decides the ontology on screen.
  if (detail === 0) return true;
  if (detail === 1) return !['opening', 'furniture'].includes(e.type);
  if (detail === 2) return !['opening', 'furniture', 'bench', 'light', 'room'].includes(e.type);
  return ['structure', 'road', 'water', 'stream', 'parcel', 'observation', 'drain'].includes(e.type);
}

const isFlat = (e) => ['path', 'road', 'surface', 'parcel', 'observation', 'drain', 'water', 'stream'].includes(e.type)
  || (e.zTop - e.zBase) < 0.12;

const CSS_COLOURS = {
  white: [.92, .91, .88], grey: [.55, .55, .54], gray: [.55, .55, .54], black: [.16, .16, .17],
  red: [.55, .24, .20], brown: [.42, .30, .22], beige: [.78, .71, .58], cream: [.86, .82, .70],
  yellow: [.80, .70, .36], orange: [.72, .46, .24], green: [.34, .45, .30], blue: [.32, .42, .55],
  pink: [.78, .62, .60], sandstone: [.74, .66, .50], terracotta: [.62, .35, .25],
};
const MATERIAL_COLOURS = {
  brick: [.52, .34, .29], concrete: [.62, .61, .59], glass: [.42, .55, .60],
  stone: [.63, .60, .55], wood: [.48, .36, .25], timber: [.48, .36, .25],
  'iron sheet': [.55, .42, .36], metal: [.55, .56, .58], plaster: [.78, .74, .66],
  cement_block: [.66, .64, .60], mud: [.48, .38, .28], thatch: [.60, .50, .32],
  tile: [.55, .32, .26], roof_tiles: [.55, .32, .26], slate: [.32, .34, .38],
  copper: [.35, .55, .48], zinc: [.60, .62, .63], tin: [.58, .56, .54],
};

/**
 * HOW HIGH EACH FLAT THING SITS ABOVE THE GROUND — which is to say, what covers
 * what. Water used to sit at 2 cm and land cover at 3 cm, so every creek that
 * ran through a wood was painted over by the wood: half of Boone's water was
 * invisible for that reason alone, not because it was too small or too dark.
 *
 * Land cover first, then water on top of it, then the ways on top of the water,
 * so a river shows through the forest it crosses while a bridge still reads as
 * passing over the river rather than under it.
 */
export const FLAT_ORDER = {
  surface: 0.03, parcel: 0.03,
  water: 0.06, stream: 0.06, drain: 0.06,
  path: 0.09,
  road: 0.11,
  observation: 0.14,
  default: 0.03,
};

/**
 * The height of the terrain AS DRAWN at (x, y): flat triangles on the same grid
 * and the same diagonal the mesh uses, so a draped surface and the hill agree
 * exactly rather than approximately.
 */
function drawnGroundAt(t, x, y, step = 1) {
  if (!t) return 0;
  const span = t.cell * step;
  const fx = (x - t.bounds[0]) / span, fy = (y - t.bounds[1]) / span;
  const ci = Math.floor(fx), cj = Math.floor(fy);
  const i = ci * step, j = cj * step;
  const u = fx - ci, v = fy - cj;
  const h00 = t.at(i, j), h10 = t.at(i + step, j);
  const h11 = t.at(i + step, j + step), h01 = t.at(i, j + step);
  // the mesh emits (00,10,11) then (00,11,01): the diagonal runs 00 → 11
  return v <= u
    ? h00 + (h10 - h00) * u + (h11 - h10) * v
    : h00 + (h11 - h01) * u + (h01 - h00) * v;
}

/** OSM writes colours as names or hex; both are honoured before any guess. */
function parseColour(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (CSS_COLOURS[s]) return CSS_COLOURS[s];
  const hex = /^#?([0-9a-f]{6})$/.exec(s);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  return null;
}

/** A city is not one colour. Vary deterministically so a place looks the same twice. */
function vary(base, seed, amount = 0.09) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  const r = ((h >>> 0) % 1000) / 1000 - 0.5;
  const g = (((h >>> 7) >>> 0) % 1000) / 1000 - 0.5;
  const b = (((h >>> 13) >>> 0) % 1000) / 1000 - 0.5;
  return [
    Math.max(0.05, Math.min(1, base[0] + r * amount)),
    Math.max(0.05, Math.min(1, base[1] + g * amount)),
    Math.max(0.05, Math.min(1, base[2] + b * amount)),
  ];
}

const WATER_COLOURS = {
  ocean: [0.11, 0.30, 0.50], bay: [0.12, 0.32, 0.52], lake: [0.14, 0.36, 0.56],
  reservoir: [0.13, 0.34, 0.54], pond: [0.17, 0.40, 0.58], river: [0.16, 0.40, 0.60],
  canal: [0.18, 0.42, 0.58], stream: [0.22, 0.48, 0.64], channel: [0.20, 0.45, 0.62],
  drain: [0.25, 0.36, 0.44], ditch: [0.26, 0.38, 0.44], wetland: [0.28, 0.44, 0.44],
  coastline: [0.14, 0.36, 0.56],
};

function colorFor(e) {
  if (e.epistemic === 'DISPUTED') return PALETTE.disputed;
  if (e.type === 'water' || e.type === 'stream') {
    return WATER_COLOURS[e.subtype] || PALETTE.water;
  }
  if (e.type === 'structure') {
    const stated = parseColour(e.props?.colour);
    if (stated) return stated;
    const mat = MATERIAL_COLOURS[String(e.material || '').toLowerCase()];
    if (mat) return vary(mat, e.id, 0.07);
    return vary(PALETTE.structure, e.id, 0.13);
  }
  if (e.type === 'marker') return [0.85, 0.72, 0.42];
  if (e.type === 'rail') return [0.36, 0.35, 0.34];
  if (e.type === 'structure' && e.material === 'iron sheet') return PALETTE.iron;
  if (e.subtype === 'garden') return [0.33, 0.48, 0.28];
  if (e.subtype === 'swale') return [0.30, 0.45, 0.40];
  if (e.subtype === 'desire-line') return [0.55, 0.48, 0.30];
  if (e.material === 'glass') return [0.55, 0.75, 0.78];
  return PALETTE[TYPE_COLOR[e.type]] || [0.5, 0.5, 0.5];
}
function roofColorFor(e) {
  if (e.type !== 'structure') return colorFor(e);
  const stated = parseColour(e.props?.roof?.colour);
  if (stated) return stated;
  const mat = MATERIAL_COLOURS[String(e.props?.roof?.material || '').toLowerCase()];
  if (mat) return vary(mat, `${e.id}r`, 0.06);
  const wall = colorFor(e);
  return [wall[0] * 0.78, wall[1] * 0.76, wall[2] * 0.74];   // roofs read darker than walls
}

/** Roof height when OSM does not say: enough to read as a roof, never dominant. */
function roofHeightFor(e, ring) {
  const stated = e.props?.roof?.height;
  if (Number.isFinite(stated) && stated > 0) return stated;
  const ob = G.orientedBounds(ring);
  return Math.max(1.2, Math.min(4.5, Math.min(ob.width, ob.depth) * 0.28));
}

function terrainColor(h, t, water, x, y) {
  // Normalise on the 5th-95th percentile, not min-max: one hillside 200 m above
  // the town used to push the entire town to the dark end of the ramp, and the
  // place read as black.
  if (t.__lo === undefined) {
    const sorted = Float32Array.from(t.data).sort();
    t.__lo = sorted[Math.floor(sorted.length * 0.05)];
    t.__hi = sorted[Math.floor(sorted.length * 0.95)];
    if (t.__hi - t.__lo < 1) { t.__lo -= 0.5; t.__hi += 0.5; }
  }
  const f = Math.max(0, Math.min(1, (h - t.__lo) / (t.__hi - t.__lo)));
  const base = [
    PALETTE.ground[0] + (PALETTE.groundHigh[0] - PALETTE.ground[0]) * f,
    PALETTE.ground[1] + (PALETTE.groundHigh[1] - PALETTE.ground[1]) * f,
    PALETTE.ground[2] + (PALETTE.groundHigh[2] - PALETTE.ground[2]) * f,
  ];
  // NO HYPSOMETRY. Green already means vegetation in this render — a wood, a
  // lawn, a park — so spending it a second time on "low ground" gives one
  // colour two jobs, and the result reads as arbitrary bands belonging to
  // nothing. Elevation is stated exactly by the contours, which are a measured
  // line rather than a wash. The ground stays one quiet material so that what
  // is actually on it is the thing you see.
  return base;
}

// ------------------------------------------------------------- mesh builders --
class Builder {
  constructor() { this.pos = []; this.nrm = []; this.col = []; this.count = 0; }
  vert(p, n, c, a) {
    this.pos.push(p[0], p[1], p[2]);
    this.nrm.push(n[0], n[1], n[2]);
    this.col.push(c[0], c[1], c[2], a);
    this.count++;
  }
  tri(a, b, c, n, col, alpha) { this.vert(a, n, col, alpha); this.vert(b, n, col, alpha); this.vert(c, n, col, alpha); }
  quad(a, b, c, d, col, alpha) {
    const n = normalOf(a, b, c);
    this.tri(a, b, c, n, col, alpha);
    this.tri(a, c, d, n, col, alpha);
  }
  /**
   * A polygon that follows the ground rather than hovering at one height.
   * The ring is cut into terrain-sized pieces first, so the surface bends with
   * the hill instead of spanning it: a road across a slope was being drawn at
   * the height of its first vertex, which on a steep place put it a hundred
   * metres inside the hillside.
   */
  draped(ring, groundAt, offset, col, alpha = 1, cell = 12, grid = null) {
    for (const piece of G.tileRing(ring, cell, grid)) {
      const idx = G.triangulate(piece);
      for (let i = 0; i < idx.length; i += 3) {
        const p = [piece[idx[i]], piece[idx[i + 1]], piece[idx[i + 2]]];
        const v = p.map((q) => [q[0], q[1], groundAt(q[0], q[1]) + offset]);
        // Each piece now has its own tilt, so it needs its own normal — a road
        // lying on a hillside must catch the light like the hillside does.
        this.tri(v[0], v[1], v[2], normalOf(v[0], v[1], v[2]), col, alpha);
      }
    }
  }
  polygon(ring, z, col, alpha) {
    const idx = G.triangulate(ring);
    for (let i = 0; i < idx.length; i += 3) {
      const a = [ring[idx[i]][0], ring[idx[i]][1], z];
      const b = [ring[idx[i + 1]][0], ring[idx[i + 1]][1], z];
      const c = [ring[idx[i + 2]][0], ring[idx[i + 2]][1], z];
      this.tri(a, b, c, [0, 0, 1], col, alpha);
    }
  }
  prism(ring, zBase, zTop, sideCol, topCol, alpha = 1, withTop = true) {
    const ccw = G.ensureCCW(ring);
    const n = ccw.length;
    for (let i = 0; i < n; i++) {
      const a = ccw[i], b = ccw[(i + 1) % n];
      const e = G.norm(G.sub(b, a));
      const nrm = [e[1], -e[0], 0];
      this.quad([a[0], a[1], zBase], [b[0], b[1], zBase], [b[0], b[1], zTop], [a[0], a[1], zTop], sideCol, alpha);
      void nrm;
    }
    if (withTop) this.polygon(ccw, zTop, topCol, alpha);
  }
  /**
   * A roof with a shape, from the tags OSM actually carries. Gabled and hipped
   * roofs are built against the footprint's own long axis, so a building at
   * 31° to north gets a ridge at 31°, not one aligned to the world.
   */
  roof(ring, zEaves, zApex, shape, col) {
    const ccw = G.ensureCCW(ring);
    const ob = G.orientedBounds(ccw);
    const dir = [Math.cos(ob.angle), Math.sin(ob.angle)];
    const long = ob.width >= ob.depth;
    const axis = long ? dir : G.perp(dir);
    const halfLen = (long ? ob.width : ob.depth) / 2;

    if (shape === 'pyramidal' || shape === 'dome' || shape === 'onion' || shape === 'conical') {
      const apex = [ob.center[0], ob.center[1], zApex];
      for (let i = 0, n = ccw.length; i < n; i++) {
        const a = ccw[i], b = ccw[(i + 1) % n];
        this.tri([a[0], a[1], zEaves], [b[0], b[1], zEaves], apex, normalOf([a[0], a[1], zEaves], [b[0], b[1], zEaves], apex), col, 1);
      }
      return;
    }

    if (shape === 'skillion' || shape === 'lean_to' || shape === 'shed') {
      // one edge lifted: height varies with distance along the short axis
      const across = long ? G.perp(dir) : dir;
      const proj = ccw.map((p) => G.dot(G.sub(p, ob.center), across));
      const lo = Math.min(...proj), hi = Math.max(...proj);
      const zOf = (p) => zEaves + (zApex - zEaves) * ((G.dot(G.sub(p, ob.center), across) - lo) / Math.max(1e-6, hi - lo));
      const idx = G.triangulate(ccw);
      for (let i = 0; i < idx.length; i += 3) {
        const a = ccw[idx[i]], b = ccw[idx[i + 1]], c = ccw[idx[i + 2]];
        const A = [a[0], a[1], zOf(a)], B = [b[0], b[1], zOf(b)], C = [c[0], c[1], zOf(c)];
        this.tri(A, B, C, normalOf(A, B, C), col, 1);
      }
      // close the raised gable end
      for (let i = 0, n = ccw.length; i < n; i++) {
        const a = ccw[i], b = ccw[(i + 1) % n];
        this.quad([a[0], a[1], zEaves], [b[0], b[1], zEaves], [b[0], b[1], zOf(b)], [a[0], a[1], zOf(a)], col, 1);
      }
      return;
    }

    // gabled (and hipped, with the ridge pulled in from the ends)
    const inset = shape === 'hipped' || shape === 'half-hipped' ? Math.min(halfLen * 0.55, (long ? ob.depth : ob.width) / 2) : 0;
    const r0 = [ob.center[0] - axis[0] * (halfLen - inset), ob.center[1] - axis[1] * (halfLen - inset), zApex];
    const r1 = [ob.center[0] + axis[0] * (halfLen - inset), ob.center[1] + axis[1] * (halfLen - inset), zApex];
    const onRidge = (p) => {
      const t = Math.max(0, Math.min(1, (G.dot(G.sub(p, [r0[0], r0[1]]), axis)) / Math.max(1e-6, 2 * (halfLen - inset))));
      return [r0[0] + (r1[0] - r0[0]) * t, r0[1] + (r1[1] - r0[1]) * t, zApex];
    };
    for (let i = 0, n = ccw.length; i < n; i++) {
      const a = ccw[i], b = ccw[(i + 1) % n];
      const A = [a[0], a[1], zEaves], B = [b[0], b[1], zEaves];
      const ra = onRidge(a), rb = onRidge(b);
      if (G.dist([ra[0], ra[1]], [rb[0], rb[1]]) < 0.05) {
        this.tri(A, B, ra, normalOf(A, B, ra), col, 1);
      } else {
        this.quad(A, B, rb, ra, col, 1);
      }
    }
  }

  cone(c, r, zBase, zTop, col, seg) {
    const apex = [c[0], c[1], zTop];
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      const p0 = [c[0] + Math.cos(a0) * r, c[1] + Math.sin(a0) * r, zBase];
      const p1 = [c[0] + Math.cos(a1) * r, c[1] + Math.sin(a1) * r, zBase];
      this.tri(p0, p1, apex, normalOf(p0, p1, apex), col, 1);
      this.tri(p1, p0, [c[0], c[1], zBase], [0, 0, -1], col, 1);
    }
  }
}

class LineBuilder {
  constructor() { this.pos = []; this.col = []; this.count = 0; }
  segment(a, b, col, alpha) {
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    this.col.push(col[0], col[1], col[2], alpha, col[0], col[1], col[2], alpha);
    this.count += 2;
  }
  ring(r, z, col, alpha, groundAt = null, offset = 0) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      // an outline on a hillside has to follow the hillside too
      const za = groundAt ? groundAt(a[0], a[1]) + offset : z;
      const zb = groundAt ? groundAt(b[0], b[1]) + offset : z;
      this.segment([a[0], a[1], za], [b[0], b[1], zb], col, alpha);
    }
  }
}

function normalOf(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

function makeMesh(gl) {
  const vao = gl.createVertexArray();
  const pos = gl.createBuffer(), nrm = gl.createBuffer(), col = gl.createBuffer();
  gl.bindVertexArray(vao);
  bindAttr(gl, pos, 0, 3);
  bindAttr(gl, nrm, 1, 3);
  bindAttr(gl, col, 2, 4);
  gl.bindVertexArray(null);
  return {
    vao, pos, nrm, col, count: 0,
    upload(b) {
      gl.bindBuffer(gl.ARRAY_BUFFER, pos); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(b.pos), gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, nrm); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(b.nrm), gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, col); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(b.col), gl.DYNAMIC_DRAW);
      this.count = b.count;
    },
    draw(g) { if (!this.count) return; g.bindVertexArray(vao); g.drawArrays(g.TRIANGLES, 0, this.count); g.bindVertexArray(null); },
  };
}

function makeLineMesh(gl) {
  const vao = gl.createVertexArray();
  const pos = gl.createBuffer(), col = gl.createBuffer();
  gl.bindVertexArray(vao);
  bindAttr(gl, pos, 0, 3);
  bindAttr(gl, col, 1, 4);
  gl.bindVertexArray(null);
  return {
    vao, count: 0,
    upload(b) {
      gl.bindBuffer(gl.ARRAY_BUFFER, pos); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(b.pos), gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, col); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(b.col), gl.DYNAMIC_DRAW);
      this.count = b.count;
    },
    draw(g) { if (!this.count) return; g.bindVertexArray(vao); g.drawArrays(g.LINES, 0, this.count); g.bindVertexArray(null); },
  };
}

function bindAttr(gl, buf, loc, size) {
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
}

function link(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

// -------------------------------------------------------------- camera math --
export function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) / (near - far), -1,
    0, 0, (2 * far * near) / (near - far), 0,
  ]);
}

export function lookAt(eye, center, up = [0, 0, 1]) {
  const z = normalize3(sub3(eye, center));
  const x = normalize3(cross3(up, z));
  const y = cross3(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot3(x, eye), -dot3(y, eye), -dot3(z, eye), 1,
  ]);
}

export function multiply(a, b) {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
      out[i * 4 + j] = s;
    }
  }
  return out;
}

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Screen point → world ray. Picking happens against real geometry, on the CPU. */
export function screenRay(x, y, width, height, eye, target, fovy, aspect) {
  const ndcX = (x / width) * 2 - 1;
  const ndcY = 1 - (y / height) * 2;
  const forward = normalize3(sub3(target, eye));
  const right = normalize3(cross3(forward, [0, 0, 1]));
  const up = cross3(right, forward);
  const th = Math.tan(fovy / 2);
  const dir = normalize3([
    forward[0] + right[0] * ndcX * th * aspect + up[0] * ndcY * th,
    forward[1] + right[1] * ndcX * th * aspect + up[1] * ndcY * th,
    forward[2] + right[2] * ndcX * th * aspect + up[2] * ndcY * th,
  ]);
  return { origin: eye, dir };
}
