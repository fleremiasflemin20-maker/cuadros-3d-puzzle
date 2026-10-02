// Motor de geometría: corre en un Web Worker para no congelar la página.
// Es la versión web de cuadro_puzzle.py (misma lógica de pestañas y holgura).
import Module from "https://cdn.jsdelivr.net/npm/manifold-3d@3.5.4/manifold.js";

const listo = Module().then(wasm => { wasm.setup(); return wasm; });

const NOMBRES = { "0,1": "pieza_A_sup_izq", "1,1": "pieza_B_sup_der", "0,0": "pieza_C_inf_izq", "1,0": "pieza_D_inf_der" };

self.onmessage = async e => {
  try {
    const wasm = await listo;
    if (e.data.cmd === "calentar") return self.postMessage({ tipo: "listo" });
    if (e.data.cmd === "contornos") return self.postMessage({ tipo: "contornos", ...contornosPlanos(wasm, e.data) });
    if (e.data.cmd === "generar") return generar(wasm, e.data);
  } catch (err) {
    self.postMessage({ tipo: "error", mensaje: String(err && err.message || err) });
  }
};

// ---------- contornos de las piezas ----------

function pestana(CS, px, py, dx, dy, r, cuello, largo) {
  const cabeza = CS.circle(r, 96).translate([px + dx * (largo - r), py + dy * (largo - r)]);
  let c;
  if (dx !== 0) {
    c = CS.square([largo - r + 0.01, cuello]).translate([0, -cuello / 2]);
    c = dx > 0 ? c.translate([px - 0.01, py]) : c.translate([px - (largo - r), py]);
  } else {
    c = CS.square([cuello, largo - r + 0.01]).translate([-cuello / 2, 0]);
    c = dy > 0 ? c.translate([px, py - 0.01]) : c.translate([px, py - (largo - r)]);
  }
  return cabeza.add(c);
}

function contornos({ CrossSection: CS }, W, H, holgura) {
  const mx = W / 2, my = H / 2;
  const lado = Math.min(W, H) / 2;
  const r = Math.max(5, lado * 0.03), cuello = r * 1.1, largo = r * 2.2;
  const rect = {
    "0,1": [0, my, mx, H], "1,1": [mx, my, W, H],
    "0,0": [0, 0, mx, my], "1,0": [mx, 0, W, my],
  };
  const forma = {};
  for (const [k, [x0, y0, x1, y1]] of Object.entries(rect)) forma[k] = CS.square([x1 - x0, y1 - y0]).translate([x0, y0]);

  const pest = [];
  [[0, my], [my, H]].forEach(([y0, y1], fila) => [1 / 3, 2 / 3].forEach((f, k) => {
    const y = y0 + (y1 - y0) * f, der = (k + fila) % 2 === 0;
    pest.push([der ? `0,${fila}` : `1,${fila}`, der ? `1,${fila}` : `0,${fila}`, pestana(CS, mx, y, der ? 1 : -1, 0, r, cuello, largo)]);
  }));
  [[0, mx], [mx, W]].forEach(([x0, x1], col) => [1 / 3, 2 / 3].forEach((f, k) => {
    const x = x0 + (x1 - x0) * f, arriba = (k + col) % 2 === 1;
    pest.push([arriba ? `${col},0` : `${col},1`, arriba ? `${col},1` : `${col},0`, pestana(CS, x, my, 0, arriba ? 1 : -1, r, cuello, largo)]);
  }));
  for (const [dueno, vecino, cs] of pest) {
    forma[dueno] = forma[dueno].add(cs);
    forma[vecino] = forma[vecino].subtract(cs);
  }
  for (const k in forma) forma[k] = forma[k].offset(-holgura / 2, "Round", 2, 64);
  return forma;
}

function contornosPlanos(wasm, { W, H, holgura }) {
  const forma = contornos(wasm, W, H, holgura);
  const out = {};
  let mayor = 0;
  for (const k in forma) {
    out[k] = forma[k].toPolygons();
    const b = forma[k].bounds();
    mayor = Math.max(mayor, b.max[0] - b.min[0], b.max[1] - b.min[1]);
  }
  return { poligonos: out, mayor };
}

// ---------- losa de relieve ----------

function losa({ Manifold, Mesh }, z, nxT, i0, i1, j0, j1, rx, ry) {
  const nx = i1 - i0 + 1, ny = j1 - j0 + 1;
  const per = [];
  for (let i = 0; i < nx; i++) per.push(i);                         // borde inferior
  for (let j = 1; j < ny; j++) per.push(j * nx + nx - 1);           // derecho
  for (let i = nx - 2; i >= 0; i--) per.push((ny - 1) * nx + i);    // superior
  for (let j = ny - 2; j > 0; j--) per.push(j * nx);                // izquierdo
  const nTop = nx * ny, nPer = per.length;
  const v = new Float32Array((nTop + nPer + 1) * 3);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const o = (j * nx + i) * 3;
    v[o] = (i0 + i) * rx; v[o + 1] = (j0 + j) * ry; v[o + 2] = z[(j0 + j) * nxT + i0 + i];
  }
  for (let p = 0; p < nPer; p++) {
    const o = (nTop + p) * 3, s = per[p] * 3;
    v[o] = v[s]; v[o + 1] = v[s + 1]; v[o + 2] = 0;
  }
  const c = (nTop + nPer) * 3;
  v[c] = (i0 + (nx - 1) / 2) * rx; v[c + 1] = (j0 + (ny - 1) / 2) * ry; v[c + 2] = 0;

  const t = new Uint32Array(((nx - 1) * (ny - 1) * 2 + nPer * 3) * 3);
  let q = 0;
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, d = a + nx, cc = d + 1;
    t[q++] = a; t[q++] = b; t[q++] = cc;
    t[q++] = a; t[q++] = cc; t[q++] = d;
  }
  const centro = nTop + nPer;
  for (let p = 0; p < nPer; p++) {
    const at = per[p], bt = per[(p + 1) % nPer], ab = nTop + p, bb = nTop + (p + 1) % nPer;
    t[q++] = ab; t[q++] = bb; t[q++] = bt;          // pared
    t[q++] = ab; t[q++] = bt; t[q++] = at;
    t[q++] = centro; t[q++] = bb; t[q++] = ab;      // fondo
  }
  const mesh = new Mesh({ numProp: 3, vertProperties: v, triVerts: t });
  return new Manifold(mesh);
}

// ---------- STL ----------

function stl(v, t, dx, dy) {
  const n = t.length / 3;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  const titulo = "cuadros-3d-puzzle";
  for (let i = 0; i < titulo.length; i++) dv.setUint8(i, titulo.charCodeAt(i));
  dv.setUint32(80, n, true);
  let o = 84;
  for (let k = 0; k < n; k++) {
    const a = t[3 * k] * 3, b = t[3 * k + 1] * 3, c = t[3 * k + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true);
    o += 12;
    for (const p of [a, b, c]) {
      dv.setFloat32(o, v[p] - dx, true); dv.setFloat32(o + 4, v[p + 1] - dy, true); dv.setFloat32(o + 8, v[p + 2], true);
      o += 12;
    }
    o += 2;
  }
  return buf;
}

// ---------- generar ----------

function generar(wasm, { z, nx, ny, W, H, holgura, cama }) {
  const rx = W / (nx - 1), ry = H / (ny - 1);
  let zMax = 0;
  for (let i = 0; i < z.length; i++) if (z[i] > zMax) zMax = z[i];
  const forma = contornos(wasm, W, H, holgura);
  for (const k in forma) {
    const b = forma[k].bounds();
    const m = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]);
    if (m > cama - 5) throw new Error(`Una pieza mide ${Math.round(m)} mm y no cabe en la cama de ${cama} mm. Baja el tamaño del cuadro.`);
  }
  const claves = ["0,1", "1,1", "0,0", "1,0"];
  claves.forEach((k, idx) => {
    self.postMessage({ tipo: "progreso", paso: idx, total: claves.length });
    const cs = forma[k];
    const b = cs.bounds();
    const i0 = Math.max(0, Math.floor(b.min[0] / rx) - 1), i1 = Math.min(nx - 1, Math.ceil(b.max[0] / rx) + 1);
    const j0 = Math.max(0, Math.floor(b.min[1] / ry) - 1), j1 = Math.min(ny - 1, Math.ceil(b.max[1] / ry) + 1);
    const slab = losa(wasm, z, nx, i0, i1, j0, j1, rx, ry);
    const ext = cs.extrude(zMax + 1);
    const pieza = slab.intersect(ext);
    const mesh = pieza.getMesh();
    const v = Float32Array.from(mesh.vertProperties);
    const t = Uint32Array.from(mesh.triVerts);
    const archivo = stl(v, t, b.min[0], b.min[1]);
    slab.delete(); ext.delete(); pieza.delete();
    self.postMessage({
      tipo: "pieza", clave: k, nombre: NOMBRES[k], stl: archivo, v, t,
      ancho: b.max[0] - b.min[0], alto: b.max[1] - b.min[1],
    }, [archivo, v.buffer, t.buffer]);
  });
  self.postMessage({ tipo: "fin" });
}
