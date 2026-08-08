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
  float ambient = 0.52 + 0.13 * aNormal.z;
  vColor = vec4(aColor.rgb * (ambient + 0.55 * lambert), aColor.a);
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
  tree: [0.28, 0.44, 0.26],
  treeTrunk: [0.30, 0.25, 0.20],
  surface: [0.40, 0.44, 0.31],
  market: [0.64, 0.52, 0.34],
  bench: [0.50, 0.40, 0.30],
  light: [0.72, 0.70, 0.60],
  observation: [0.95, 0.72, 0.25],
  disputed: [0.90, 0.45, 0.30],
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
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
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
            cutawayAt = null } = opts;
    this.fidelity = fidelity;
    const S = new Builder();        // opaque
    const T = new Builder();        // translucent
    const L = new LineBuilder();

    if (world.place.terrain && fidelity !== 'symbolic') this.buildTerrain(S, world, overlay, fidelity);

    const ents = world.entities();
    const detail = { high: 0, medium: 1, low: 2, symbolic: 3 }[fidelity];

    for (const e of ents) {
      if (!visibleAt(e, detail)) continue;
      const ring = world.ringOf(e);
      if (!ring || ring.length < 3) continue;
      const col = colorFor(e);
      const sel = selection.has(e.id);
      const hi = highlight.has(e.id);

      if (e.type === 'tree') {
        this.buildTree(S, e, ring, detail);
      } else if (isFlat(e)) {
        S.polygon(ring, e.zTop + 0.03, col, 1);
        if (e.type === 'observation') this.buildPin(S, L, e, ring);
      } else {
        // Standing inside a building, the roof is the one thing you do not want
        // to look at. What matters changes with where you are (§17).
        const cutaway = cutawayAt && e.type === 'structure' && G.pointInRing(cutawayAt, ring);
        S.prism(ring, e.zBase, e.zTop, col, roofColorFor(e), 1, !cutaway);
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
      if (isFlat(g)) T.polygon(ring, g.zTop + 0.05, col, 0.42);
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
          if (d <= 0.02) continue;
          const x = w.bounds[0] + i * w.cell, y = w.bounds[1] + j * w.cell;
          const z = w.elev[j * w.nx + i] + d;
          const t = Math.min(1, d / 0.45);
          const col = [0.16 + 0.06 * (1 - t), 0.45 - 0.16 * t, 0.72 - 0.12 * t];
          T.quad([x, y, z], [x + w.cell, y, z], [x + w.cell, y + w.cell, z], [x, y + w.cell, z], col, 0.35 + 0.42 * t);
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

function colorFor(e) {
  if (e.epistemic === 'DISPUTED') return PALETTE.disputed;
  if (e.type === 'structure' && e.material === 'iron sheet') return PALETTE.iron;
  if (e.subtype === 'garden') return [0.33, 0.48, 0.28];
  if (e.subtype === 'swale') return [0.30, 0.45, 0.40];
  if (e.subtype === 'desire-line') return [0.55, 0.48, 0.30];
  if (e.material === 'glass') return [0.55, 0.75, 0.78];
  return PALETTE[TYPE_COLOR[e.type]] || [0.5, 0.5, 0.5];
}
function roofColorFor(e) {
  if (e.type === 'structure') return e.material === 'iron sheet' ? [0.46, 0.36, 0.32] : PALETTE.roof;
  return colorFor(e);
}

function terrainColor(h, t, water, x, y) {
  let lo = Infinity, hi = -Infinity;
  lo = t.__lo ?? (t.__lo = Math.min(...t.data));
  hi = t.__hi ?? (t.__hi = Math.max(...t.data));
  const f = hi > lo ? (h - lo) / (hi - lo) : 0.5;
  return [
    PALETTE.ground[0] + (PALETTE.groundHigh[0] - PALETTE.ground[0]) * f,
    PALETTE.ground[1] + (PALETTE.groundHigh[1] - PALETTE.ground[1]) * f,
    PALETTE.ground[2] + (PALETTE.groundHigh[2] - PALETTE.ground[2]) * f,
  ];
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
  ring(r, z, col, alpha) {
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      this.segment([a[0], a[1], z], [b[0], b[1], z], col, alpha);
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
