import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const $ = s => document.querySelector(s);
const app = $("#app"), escenario = $("#escenario"), tarjeta = $("#tarjeta");
const ctrl = {
  archivo: $("#archivo"), impresora: $("#impresora"), camaMm: $("#cama-mm"), tamano: $("#tamano"),
  relieve: $("#relieve"), invertir: $("#invertir"), marco: $("#marco"), contraste: $("#contraste"),
};
const BASE = 3, MARCO = 10, HOLGURA = 0.25;
const COLORES = { "0,1": "#FF6A2B", "1,1": "#3EA6FF", "0,0": "#3DDC97", "1,0": "#F5C542" };
const LETRA = { "0,1": "A", "1,1": "B", "0,0": "C", "1,0": "D" };
const POS = { "0,1": [-1, 1], "1,1": [1, 1], "0,0": [-1, -1], "1,0": [1, -1] };

const estado = { img: null, nombre: "", piezas: {}, urls: [], generando: false, desactualizado: false };

// ---------- motor (Web Worker) ----------
const motor = new Worker("motor.js", { type: "module" });
let idPedido = 0;
const pendientes = new Map();
motor.onmessage = e => {
  const m = e.data;
  if (m.tipo === "contornos") { const r = pendientes.get("contornos"); if (r) r(m); return; }
  if (m.tipo === "progreso") return progreso(m.paso, m.total);
  if (m.tipo === "pieza") return recibirPieza(m);
  if (m.tipo === "fin") return terminar();
  if (m.tipo === "error") return mostrarError(m.mensaje);
};
motor.onerror = () => mostrarError("No se pudo cargar el motor 3D. Revisa tu conexión a internet y recarga la página.");
motor.postMessage({ cmd: "calentar" });

function pedirContornos(W, H) {
  return new Promise(res => {
    const id = ++idPedido;
    pendientes.set("contornos", m => { if (id === idPedido) res(m); });
    motor.postMessage({ cmd: "contornos", W, H, holgura: HOLGURA });
  });
}

// ---------- medidas ----------
function cama() {
  return ctrl.impresora.value === "otra" ? Math.max(100, +ctrl.camaMm.value || 0) : +ctrl.impresora.value;
}
function aspecto() { return estado.img ? estado.img.naturalHeight / estado.img.naturalWidth : 1; }

function extensionPieza(L, k) {           // L = lado mayor, k = lado menor / lado mayor
  const largo = 2.2 * Math.max(5, (L * k) / 2 * 0.03);
  return L / 2 + largo;
}
function tamanoMaxCm() {
  const a = aspecto(), k = a > 1 ? 1 / a : a, limite = cama() - 12;
  let lo = 100, hi = 4000;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; extensionPieza(m, k) <= limite ? (lo = m) : (hi = m); }
  return Math.floor(lo / 10);
}
function medidas() {
  const L = +ctrl.tamano.value * 10, a = aspecto();
  return a <= 1 ? { W: L, H: +(L * a).toFixed(1) } : { W: +(L / a).toFixed(1), H: L };
}
function resolucion() { return +document.querySelector('input[name=calidad]:checked').value; }

function actualizarTextos() {
  const max = tamanoMaxCm();
  ctrl.tamano.max = max;
  if (+ctrl.tamano.value > max) ctrl.tamano.value = max;
  const { W, H } = medidas();
  $("#out-tamano").textContent = `${Math.round(W / 10)} × ${Math.round(H / 10)} cm`;
  $("#ayuda-tamano").textContent = `Cada pieza: ${Math.round(W / 20)} × ${Math.round(H / 20)} cm aprox. Máximo para tu impresora: ${max} cm.`;
  $("#out-relieve").textContent = `${(+ctrl.relieve.value).toLocaleString("es")} mm`;
  const res = resolucion();
  const mb = 2 * (W / 2 / res) * (H / 2 / res) * 50 / 1e6;
  const seg = { "1": "unos segundos", "0.6": "unos 10–30 segundos", "0.4": "hasta 1 minuto" }[String(res)];
  $("#ayuda-calidad").textContent = `≈ ${Math.max(1, Math.round(mb))} MB por pieza · tarda ${seg}.`;
  document.querySelectorAll("input[type=range]").forEach(r => {
    r.style.setProperty("--p", `${((r.value - r.min) / (r.max - r.min)) * 100}%`);
  });
  $("#caja-cama").classList.toggle("ver", ctrl.impresora.value === "otra");
}

// ---------- imagen → mapa de alturas ----------
function procesar(res) {
  const { W, H } = medidas();
  const nx = Math.round(W / res) + 1, ny = Math.round(H / res) + 1;
  const c = document.createElement("canvas");
  c.width = nx; c.height = ny;
  const cx = c.getContext("2d", { willReadFrequently: true });
  cx.fillStyle = "#fff"; cx.fillRect(0, 0, nx, ny);           // fondo blanco para PNG transparentes
  cx.imageSmoothingQuality = "high";
  cx.drawImage(estado.img, 0, 0, nx, ny);
  const d = cx.getImageData(0, 0, nx, ny).data;

  let g = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const fila = ny - 1 - j;                                     // fila 0 de la imagen = arriba del cuadro
    for (let i = 0; i < nx; i++) {
      const p = (fila * nx + i) * 4;
      g[j * nx + i] = (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) / 255;
    }
  }
  if (ctrl.contraste.checked) {
    const hist = new Uint32Array(256);
    for (const v of g) hist[Math.min(255, v * 255 | 0)]++;
    const n = g.length; let acc = 0, lo = 0, hi = 255;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * 0.01) { lo = i; break; } }
    acc = 0;
    for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= n * 0.01) { hi = i; break; } }
    if (hi - lo > 8) { const a = lo / 255, b = hi / 255; for (let i = 0; i < n; i++) g[i] = Math.min(1, Math.max(0, (g[i] - a) / (b - a))); }
  }
  g = desenfocar(g, nx, ny);

  const rel = +ctrl.relieve.value, inv = ctrl.invertir.checked;
  const z = new Float32Array(nx * ny);
  const rx = W / (nx - 1), ry = H / (ny - 1), m = ctrl.marco.checked ? MARCO : 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, x = i * rx, y = j * ry;
    z[k] = (m && (x < m || x > W - m || y < m || y > H - m)) ? BASE + rel + 1 : BASE + rel * (inv ? g[k] : 1 - g[k]);
  }
  return { z, nx, ny, W, H };
}
function desenfocar(g, nx, ny) {
  const t = new Float32Array(g.length), o = new Float32Array(g.length);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = Math.max(0, i - 1), b = Math.min(nx - 1, i + 1), r = j * nx;
    t[r + i] = (g[r + a] + g[r + i] + g[r + b]) / 3;
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = Math.max(0, j - 1), b = Math.min(ny - 1, j + 1);
    o[j * nx + i] = (t[a * nx + i] + t[j * nx + i] + t[b * nx + i]) / 3;
  }
  return o;
}

// ---------- vista previa plana (sombreada) ----------
let temporizador;
function programarPrevia() {
  actualizarTextos();
  if (!estado.img) return;
  if (Object.keys(estado.piezas).length && !estado.generando) marcarDesactualizado();
  clearTimeout(temporizador);
  temporizador = setTimeout(dibujarPrevia, 120);
}
async function dibujarPrevia() {
  const { W, H } = medidas();
  const res = Math.max(W, H) / 640;
  const { z, nx, ny } = procesar(res);
  const lienzo = $("#lienzo"), esc = 2;
  lienzo.width = nx * esc; lienzo.height = ny * esc;
  const sombra = document.createElement("canvas");
  sombra.width = nx; sombra.height = ny;
  const sx = sombra.getContext("2d"), img = sx.createImageData(nx, ny);
  const L = [-0.55, 0.55, 0.63], ex = 1.8;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    const dx = (z[j * nx + Math.min(nx - 1, i + 1)] - z[j * nx + Math.max(0, i - 1)]) / (2 * res) * ex;
    const dy = (z[Math.min(ny - 1, j + 1) * nx + i] - z[Math.max(0, j - 1) * nx + i]) / (2 * res) * ex;
    const n = Math.hypot(dx, dy, 1);
    const s = Math.max(0, (-dx * L[0] - dy * L[1] + L[2]) / n);
    const f = 0.18 + 0.95 * s;
    const p = ((ny - 1 - j) * nx + i) * 4;
    img.data[p] = Math.min(255, 233 * f); img.data[p + 1] = Math.min(255, 226 * f); img.data[p + 2] = Math.min(255, 213 * f); img.data[p + 3] = 255;
  }
  sx.putImageData(img, 0, 0);
  const cx = lienzo.getContext("2d");
  cx.imageSmoothingQuality = "high";
  cx.drawImage(sombra, 0, 0, nx * esc, ny * esc);

  const { poligonos } = await pedirContornos(W, H);
  const k = (nx * esc) / W;
  cx.lineWidth = 2.5; cx.lineJoin = "round";
  for (const [clave, polys] of Object.entries(poligonos)) {
    cx.strokeStyle = COLORES[clave];
    for (const poly of polys) {
      cx.beginPath();
      poly.forEach(([x, y], i) => (i ? cx.lineTo : cx.moveTo).call(cx, x * k, (H - y) * k));
      cx.closePath(); cx.stroke();
    }
  }
  if (!app.classList.contains("modo-3d")) verModo("plano");
}

// ---------- cargar imagen ----------
function cargarImagen(src, nombre) {
  const img = new Image();
  img.onload = () => {
    estado.img = img;
    estado.nombre = nombre.replace(/\.[^.]+$/, "").replace(/[^\w\-áéíóúñÁÉÍÓÚÑ]+/g, "_").slice(0, 40) || "cuadro";
    $("#mini").src = src;
    $("#nombre-img").textContent = nombre;
    $("#info-img").textContent = `${img.naturalWidth} × ${img.naturalHeight} px`;
    $("#bloque-imagen").classList.add("con-imagen");
    $("#btn-generar").disabled = false;
    $("#txt-generar").textContent = "Generar mi cuadro";
    ctrl.tamano.value = tamanoMaxCm();
    limpiarResultados();
    verModo("plano");
    programarPrevia();
  };
  img.onerror = () => mostrarError("No se pudo leer esa imagen. Prueba con un JPG o PNG.");
  img.src = src;
}
ctrl.archivo.addEventListener("change", () => {
  const f = ctrl.archivo.files[0];
  if (f) cargarImagen(URL.createObjectURL(f), f.name);
});
$("#btn-ejemplo").addEventListener("click", () => cargarImagen("../ejemplos/mandala.png", "mandala.png"));
const drop = $("#drop");
[drop, escenario].forEach(el => {
  el.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("encima"); });
  el.addEventListener("dragleave", () => drop.classList.remove("encima"));
  el.addEventListener("drop", e => {
    e.preventDefault(); drop.classList.remove("encima");
    const f = [...e.dataTransfer.files].find(f => f.type.startsWith("image/"));
    if (f) cargarImagen(URL.createObjectURL(f), f.name);
  });
});

// ---------- controles ----------
["input", "change"].forEach(ev => {
  [ctrl.tamano, ctrl.relieve, ctrl.invertir, ctrl.marco, ctrl.contraste, ctrl.impresora, ctrl.camaMm]
    .forEach(el => el.addEventListener(ev, programarPrevia));
});
document.querySelectorAll("input[name=calidad]").forEach(r => r.addEventListener("change", () => { actualizarTextos(); if (Object.keys(estado.piezas).length) marcarDesactualizado(); }));
ctrl.impresora.addEventListener("change", () => { if (estado.img) ctrl.tamano.value = tamanoMaxCm(); programarPrevia(); });

// ---------- generar ----------
$("#btn-generar").addEventListener("click", async () => {
  if (!estado.img || estado.generando) return;
  estado.generando = true;
  limpiarResultados();
  $("#btn-generar").disabled = true;
  $("#txt-generar").textContent = "Generando…";
  mostrarTarjeta(`<h2>Preparando tu imagen…</h2><p>Esto puede tardar un poco. No cierres la pestaña.</p><div class="barra"><i style="width:4%"></i></div>`);
  await new Promise(r => setTimeout(r, 40));
  const { z, nx, ny, W, H } = procesar(resolucion());
  estado.medidas = { W, H };
  motor.postMessage({ cmd: "generar", z, nx, ny, W, H, holgura: HOLGURA, cama: cama() }, [z.buffer]);
});

function progreso(paso, total) {
  const clave = ["0,1", "1,1", "0,0", "1,0"][paso];
  mostrarTarjeta(`<h2>Creando la pieza ${LETRA[clave]} <small style="color:var(--muted);font-weight:400">(${paso + 1} de ${total})</small></h2>
    <p>Recortando el relieve y las pestañas del rompecabezas…</p>
    <div class="barra"><i style="width:${8 + (paso / total) * 88}%"></i></div>`);
}

function recibirPieza(m) {
  const blob = new Blob([m.stl], { type: "model/stl" });
  const url = URL.createObjectURL(blob);
  estado.urls.push(url);
  estado.piezas[m.clave] = { ...m, blob, url };
  agregarAlVisor(m);
}

function terminar() {
  estado.generando = false;
  estado.desactualizado = false;
  app.classList.remove("desactualizado");
  $("#btn-generar").disabled = false;
  $("#txt-generar").textContent = "Volver a generar";
  const { W, H } = estado.medidas;
  const filas = ["0,1", "1,1", "0,0", "1,0"].map(k => {
    const p = estado.piezas[k];
    return `<a href="${p.url}" download="${p.nombre}.stl"><span><span class="dot" style="background:${COLORES[k]}"></span>Pieza ${LETRA[k]} · ${p.nombre.split("_").slice(2).join(" ")}</span>
      <small>${Math.round(p.ancho)}×${Math.round(p.alto)} mm · ${(p.blob.size / 1e6).toFixed(1)} MB</small></a>`;
  }).join("");
  mostrarTarjeta(`<button class="cerrar" type="button" aria-label="Cerrar">×</button>
    <h2><span class="ok-ico"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12l5 5 9-10"/></svg></span>¡Tu cuadro está listo!</h2>
    <p>Cuadro de ${Math.round(W / 10)} × ${Math.round(H / 10)} cm en 4 piezas. Gíralo en 3D con el ratón o el dedo.</p>
    <button class="btn-zip" type="button" id="btn-zip">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 4v12M7 11l5 5 5-5M4 20h16"/></svg>
      Descargar las 4 piezas (.zip)</button>
    <div class="lista">${filas}</div>
    <p class="aviso-cambios">Cambiaste algún ajuste. Pulsa «Volver a generar» para aplicarlo.</p>`);
  tarjeta.querySelector(".cerrar").onclick = () => tarjeta.classList.remove("ver");
  $("#btn-zip").onclick = descargarZip;
  $("#v-3d").disabled = false;
  $("#v-3d").title = "";
  verModo("3d");
}

async function descargarZip() {
  const btn = $("#btn-zip");
  btn.disabled = true;
  const zip = new JSZip();
  for (const k of ["0,1", "1,1", "0,0", "1,0"]) zip.file(`${estado.piezas[k].nombre}.stl`, estado.piezas[k].blob);
  const { W, H } = estado.medidas;
  zip.file("LEEME.txt", [
    `Cuadro 3D: ${Math.round(W / 10)} x ${Math.round(H / 10)} cm en 4 piezas`, "",
    "Orden de las piezas (mirando el cuadro de frente):",
    "  A = arriba izquierda    B = arriba derecha",
    "  C = abajo izquierda     D = abajo derecha", "",
    "Cómo imprimir:",
    "  - Cada pieza con la cara plana sobre la cama.",
    "  - Capa de 0,12 a 0,16 mm para que el relieve salga fino.",
    "  - Prueba el encaje con dos piezas antes de imprimir las cuatro.",
    "  - Une las piezas por detrás con pegamento instantáneo (CA).", "",
    "Hecho con https://fleremiasflemin20-maker.github.io/cuadros-3d-puzzle/",
  ].join("\r\n"));
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 1 } },
    meta => { btn.lastChild.textContent = ` Comprimiendo… ${Math.round(meta.percent)}%`; });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `cuadro_${estado.nombre}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  btn.lastChild.textContent = " Descargar las 4 piezas (.zip)";
  btn.disabled = false;
}

function mostrarTarjeta(html, error = false) {
  tarjeta.innerHTML = html;
  tarjeta.classList.add("ver");
  tarjeta.classList.toggle("error", error);
}
function mostrarError(msg) {
  estado.generando = false;
  if (estado.img) { $("#btn-generar").disabled = false; $("#txt-generar").textContent = "Intentar de nuevo"; }
  mostrarTarjeta(`<button class="cerrar" type="button" aria-label="Cerrar">×</button><h2>Algo salió mal</h2><p>${msg}</p>`, true);
  tarjeta.querySelector(".cerrar").onclick = () => tarjeta.classList.remove("ver");
}
function marcarDesactualizado() {
  estado.desactualizado = true;
  app.classList.add("desactualizado");
  tarjeta.classList.add("desactualizado");
  $("#txt-generar").textContent = "Volver a generar";
}
function limpiarResultados() {
  estado.urls.forEach(u => URL.revokeObjectURL(u));
  estado.urls = []; estado.piezas = {};
  tarjeta.classList.remove("ver", "desactualizado");
  app.classList.remove("desactualizado");
  $("#v-3d").disabled = true;
  if (visor) visor.limpiar();
  if (app.classList.contains("modo-3d")) verModo("plano");
}

// ---------- modos de vista ----------
function verModo(m) {
  app.classList.toggle("modo-plano", m === "plano");
  app.classList.toggle("modo-3d", m === "3d");
  escenario.classList.toggle("modo-plano", m === "plano");
  escenario.classList.toggle("modo-3d", m === "3d");
  $("#v-plano").setAttribute("aria-pressed", m === "plano");
  $("#v-3d").setAttribute("aria-pressed", m === "3d");
  $("#btn-separar").hidden = m !== "3d";
  if (m === "3d" && visor) visor.ajustar();
}
$("#v-plano").onclick = () => verModo("plano");
$("#v-3d").onclick = () => verModo("3d");

// ---------- visor 3D ----------
let visor = null;
function crearVisor() {
  const cont = $("#visor");
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  cont.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 5, 20000);
  scene.add(new THREE.HemisphereLight(0xfff4e8, 0x15110e, 0.6));
  const clave = new THREE.DirectionalLight(0xfff1e0, 2.4); clave.position.set(-700, 600, 450); scene.add(clave);
  const acento = new THREE.DirectionalLight(0xff6a2b, 0.6); acento.position.set(800, -400, 200); scene.add(acento);
  const relleno = new THREE.DirectionalLight(0xffffff, 0.45); relleno.position.set(200, 0, 1000); scene.add(relleno);
  const grupo = new THREE.Group(); scene.add(grupo);
  const material = new THREE.MeshStandardMaterial({ color: 0xE9E2D5, roughness: 0.6 });
  const controles = new OrbitControls(camera, renderer.domElement);
  controles.enableDamping = true;
  controles.dampingFactor = 0.08;
  controles.screenSpacePanning = true;
  const mallas = [];
  let separar = 0, separarObj = 0, encuadrado = false;

  function ajustar() {
    const w = cont.clientWidth, h = cont.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (!encuadrado && mallas.length) { encuadrar(); encuadrado = true; }
  }
  new ResizeObserver(ajustar).observe(cont);

  function encuadrar() {
    const { W, H } = estado.medidas;
    const tg = Math.tan(THREE.MathUtils.degToRad(16));
    const d = Math.max(H / 2 / tg, W / 2 / (tg * camera.aspect)) * 1.3;
    camera.position.set(-d * 0.18, -d * 0.42, d * 0.88);
    controles.target.set(0, 0, 0);
    controles.update();
  }

  function bucle() {
    requestAnimationFrame(bucle);
    if (!app.classList.contains("modo-3d")) return;
    separar += (separarObj - separar) * 0.12;
    for (const m of mallas) m.position.set(m.userData.d[0] * separar, m.userData.d[1] * separar, 0);
    controles.update();
    renderer.render(scene, camera);
  }
  bucle();

  $("#btn-separar").onclick = () => {
    separarObj = separarObj ? 0 : Math.max(estado.medidas.W, estado.medidas.H) * 0.06;
    $("#btn-separar").textContent = separarObj ? "Unir piezas" : "Separar piezas";
  };

  return {
    ajustar,
    agregar(p) {
      const { W, H } = estado.medidas;
      const g = new THREE.BufferGeometry();
      const v = new Float32Array(p.v);
      for (let i = 0; i < v.length; i += 3) { v[i] -= W / 2; v[i + 1] -= H / 2; }
      g.setAttribute("position", new THREE.BufferAttribute(v, 3));
      g.setIndex(new THREE.BufferAttribute(p.t, 1));
      g.computeVertexNormals();
      const malla = new THREE.Mesh(g, material);
      malla.userData.d = POS[p.clave];
      mallas.push(malla); grupo.add(malla);
      ajustar();
    },
    limpiar() {
      for (const m of mallas) { grupo.remove(m); m.geometry.dispose(); }
      mallas.length = 0; encuadrado = false; separar = separarObj = 0;
      $("#btn-separar").textContent = "Separar piezas";
    },
  };
}
function agregarAlVisor(p) {
  if (!visor) {
    try { visor = crearVisor(); } catch { return; }   // sin WebGL: las descargas siguen funcionando
  }
  visor.agregar(p);
}

actualizarTextos();
