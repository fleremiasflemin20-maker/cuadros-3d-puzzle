#!/usr/bin/env python3
"""
Cuadro en relieve 3D dividido en 4 piezas (2x2) con encajes de rompecabezas.

Uso:
  .venv/bin/python cuadro_puzzle.py mi_imagen.jpg
  .venv/bin/python cuadro_puzzle.py mi_imagen.jpg --ancho 600 --relieve 5 --invertir

Genera en la carpeta "salida_<nombre>":
  pieza_A_sup_izq.stl, pieza_B_sup_der.stl, pieza_C_inf_izq.stl, pieza_D_inf_der.stl
  vista_previa.png
"""
import argparse
import math
import os
import struct

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps
from manifold3d import CrossSection, JoinType, Manifold, Mesh

CAMA_K2_PLUS = 350.0  # mm


def leer_args():
    p = argparse.ArgumentParser(description="Cuadro 3D en 4 piezas tipo rompecabezas")
    p.add_argument("imagen")
    p.add_argument("--ancho", type=float, default=620, help="ancho total del cuadro en mm (default 620)")
    p.add_argument("--base", type=float, default=3.0, help="grosor de la base en mm (default 3)")
    p.add_argument("--relieve", type=float, default=4.0, help="altura máxima del relieve en mm (default 4)")
    p.add_argument("--invertir", action="store_true", help="zonas claras salen altas (por defecto salen las oscuras)")
    p.add_argument("--marco", type=float, default=10.0, help="ancho del marco elevado en mm, 0 = sin marco (default 10)")
    p.add_argument("--res", type=float, default=0.5, help="resolución de la malla en mm (default 0.5)")
    p.add_argument("--holgura", type=float, default=0.25, help="separación entre piezas en mm (default 0.25)")
    p.add_argument("--suavizado", type=float, default=1.0, help="desenfoque de la imagen en px de malla (default 1)")
    p.add_argument("--cama", type=float, default=CAMA_K2_PLUS, help="tamaño de la cama en mm (default 350, K2 Plus)")
    p.add_argument("--salida", help="carpeta de salida (default salida_<nombre>)")
    p.add_argument("--coords-globales", action="store_true", help="no mover cada pieza al origen (útil para visores)")
    return p.parse_args()


# ---------- mapa de alturas ----------

def mapa_alturas(a, W, H, nx, ny):
    img = Image.open(a.imagen)
    img = ImageOps.exif_transpose(img).convert("L")
    img = img.resize((nx, ny), Image.LANCZOS)
    if a.suavizado > 0:
        img = img.filter(ImageFilter.GaussianBlur(a.suavizado))
    g = np.asarray(img, dtype=np.float32) / 255.0
    g = np.flipud(g)  # fila 0 de la imagen = arriba del cuadro (y máxima)
    t = g if a.invertir else 1.0 - g
    z = a.base + a.relieve * t
    if a.marco > 0:
        xs = np.linspace(0, W, nx)
        ys = np.linspace(0, H, ny)
        X, Y = np.meshgrid(xs, ys)
        borde = (X < a.marco) | (X > W - a.marco) | (Y < a.marco) | (Y > H - a.marco)
        z[borde] = a.base + a.relieve + 1.0
    return z  # shape (ny, nx)


def losa(z, x0, y0, res):
    """Malla cerrada: superficie de relieve arriba, plano z=0 abajo."""
    ny, nx = z.shape
    xs = x0 + np.arange(nx) * res
    ys = y0 + np.arange(ny) * res
    X, Y = np.meshgrid(xs, ys)
    top = np.column_stack([X.ravel(), Y.ravel(), z.ravel()])
    idx = np.arange(nx * ny).reshape(ny, nx)

    v00 = idx[:-1, :-1].ravel(); v10 = idx[:-1, 1:].ravel()
    v11 = idx[1:, 1:].ravel();   v01 = idx[1:, :-1].ravel()
    tris = [np.column_stack([v00, v10, v11]), np.column_stack([v00, v11, v01])]

    # perímetro en sentido antihorario visto desde arriba
    per = np.concatenate([idx[0, :], idx[1:, -1], idx[-1, -2::-1], idx[-2:0:-1, 0]])
    n_top = len(top)
    bot = top[per].copy(); bot[:, 2] = 0.0
    centro = np.array([[xs.mean(), ys.mean(), 0.0]])
    b_idx = n_top + np.arange(len(per))
    c_idx = n_top + len(per)
    a_t, b_t = per, np.roll(per, -1)
    a_b, b_b = b_idx, np.roll(b_idx, -1)
    tris += [np.column_stack([a_b, b_b, b_t]), np.column_stack([a_b, b_t, a_t])]   # paredes
    tris += [np.column_stack([np.full_like(a_b, c_idx), b_b, a_b])]               # fondo
    verts = np.vstack([top, bot, centro]).astype(np.float32)
    return Manifold(Mesh(vert_properties=verts, tri_verts=np.vstack(tris).astype(np.uint32)))


# ---------- contornos de las piezas ----------

def pestana(px, py, dx, dy, r, cuello, largo):
    """Pestaña de puzzle saliendo desde (px,py) en dirección (dx,dy)."""
    seg = 96
    cabeza = CrossSection.circle(r, seg).translate((px + dx * (largo - r), py + dy * (largo - r)))
    if dx != 0:
        c = CrossSection.square((largo - r + 0.01, cuello)).translate((0, -cuello / 2))
        c = c.translate((px - 0.01, py)) if dx > 0 else c.translate((px - (largo - r), py))
    else:
        c = CrossSection.square((cuello, largo - r + 0.01)).translate((-cuello / 2, 0))
        c = c.translate((px, py - 0.01)) if dy > 0 else c.translate((px, py - (largo - r)))
    return cabeza + c


def contornos(W, H, holgura):
    mx, my = W / 2, H / 2
    lado = min(W, H) / 2
    r = max(5.0, lado * 0.03)
    cuello = r * 1.1
    largo = r * 2.2
    # piezas: (col, fila) con fila 1 = arriba
    rect = {
        (0, 1): (0, my, mx, H), (1, 1): (mx, my, W, H),
        (0, 0): (0, 0, mx, my), (1, 0): (mx, 0, W, my),
    }
    forma = {k: CrossSection.square((x1 - x0, y1 - y0)).translate((x0, y0)) for k, (x0, y0, x1, y1) in rect.items()}

    pest = []  # (dueño, vecino, CrossSection)
    # costura vertical x = mx: tramo de abajo y tramo de arriba, 2 pestañas cada uno
    for fila, (y0, y1) in enumerate([(0, my), (my, H)]):
        for k, f in enumerate((1 / 3, 2 / 3)):
            y = y0 + (y1 - y0) * f
            sale_der = (k + fila) % 2 == 0
            dueno, vecino = ((0, fila), (1, fila)) if sale_der else ((1, fila), (0, fila))
            pest.append((dueno, vecino, pestana(mx, y, 1 if sale_der else -1, 0, r, cuello, largo)))
    # costura horizontal y = my
    for col, (x0, x1) in enumerate([(0, mx), (mx, W)]):
        for k, f in enumerate((1 / 3, 2 / 3)):
            x = x0 + (x1 - x0) * f
            sale_arriba = (k + col) % 2 == 1
            dueno, vecino = ((col, 0), (col, 1)) if sale_arriba else ((col, 1), (col, 0))
            pest.append((dueno, vecino, pestana(x, my, 0, 1 if sale_arriba else -1, r, cuello, largo)))

    for dueno, vecino, cs in pest:
        forma[dueno] = forma[dueno] + cs
        forma[vecino] = forma[vecino] - cs
    # holgura: cada pieza se encoge la mitad para que encajen sin forzar
    for k in forma:
        forma[k] = forma[k].offset(-holgura / 2, JoinType.Round, 2.0, 64)
    return forma, largo


# ---------- exportar ----------

def guardar_stl(m, ruta):
    mesh = m.to_mesh()
    v = np.asarray(mesh.vert_properties)[:, :3].astype(np.float32)
    t = np.asarray(mesh.tri_verts)
    a, b, c = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
    n = np.cross(b - a, c - a)
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    rec = np.zeros(len(t), dtype=[("n", "<f4", 3), ("a", "<f4", 3), ("b", "<f4", 3), ("c", "<f4", 3), ("x", "<u2")])
    rec["n"], rec["a"], rec["b"], rec["c"] = n, a, b, c
    with open(ruta, "wb") as f:
        f.write(b"cuadro_puzzle".ljust(80, b" "))
        f.write(struct.pack("<I", len(t)))
        f.write(rec.tobytes())


def vista_previa(z, forma, W, H, ruta):
    escala = 1200 / max(W, H)
    zi = (z - z.min()) / max(np.ptp(z), 1e-6)
    img = Image.fromarray(np.flipud((zi * 255).astype(np.uint8))).resize((int(W * escala), int(H * escala)))
    img = img.convert("RGB")
    d = ImageDraw.Draw(img)
    colores = {(0, 1): (230, 80, 60), (1, 1): (60, 160, 230), (0, 0): (80, 190, 90), (1, 0): (240, 180, 40)}
    for k, cs in forma.items():
        for poly in cs.to_polygons():
            pts = [(x * escala, (H - y) * escala) for x, y in poly]
            d.line(pts + [pts[0]], fill=colores[k], width=3)
    img.save(ruta)


def main():
    a = leer_args()
    with Image.open(a.imagen) as im:
        im = ImageOps.exif_transpose(im)
        aspecto = im.height / im.width
    W = a.ancho
    H = round(W * aspecto, 1)
    nx, ny = int(round(W / a.res)) + 1, int(round(H / a.res)) + 1
    res_x, res_y = W / (nx - 1), H / (ny - 1)

    forma, largo = contornos(W, H, a.holgura)
    for k, cs in forma.items():
        x0, y0, x1, y1 = cs.bounds()
        if max(x1 - x0, y1 - y0) > a.cama - 5:
            raise SystemExit(f"Una pieza mide {max(x1-x0, y1-y0):.0f} mm y no cabe en la cama de {a.cama:.0f} mm. "
                             f"Baja --ancho (o el alto por la proporción de la imagen).")

    print(f"Cuadro final: {W:.0f} x {H:.0f} mm  |  relieve {a.base}+{a.relieve} mm  |  malla {a.res:.2f} mm")
    z = mapa_alturas(a, W, H, nx, ny)
    nombre = os.path.splitext(os.path.basename(a.imagen))[0]
    salida = a.salida or f"salida_{nombre}"
    os.makedirs(salida, exist_ok=True)

    nombres = {(0, 1): "pieza_A_sup_izq", (1, 1): "pieza_B_sup_der", (0, 0): "pieza_C_inf_izq", (1, 0): "pieza_D_inf_der"}
    alto_max = float(z.max()) + 1
    for k, cs in forma.items():
        bx0, by0, bx1, by1 = cs.bounds()
        i0, i1 = max(0, int(math.floor(bx0 / res_x)) - 1), min(nx - 1, int(math.ceil(bx1 / res_x)) + 1)
        j0, j1 = max(0, int(math.floor(by0 / res_y)) - 1), min(ny - 1, int(math.ceil(by1 / res_y)) + 1)
        sub = z[j0:j1 + 1, i0:i1 + 1]
        slab = losa(sub, 0.0, 0.0, 1.0).scale((res_x, res_y, 1.0)).translate((i0 * res_x, j0 * res_y, 0.0))
        pieza = slab ^ cs.extrude(alto_max)
        if not a.coords_globales:
            pieza = pieza.translate((-bx0, -by0, 0))
        ruta = os.path.join(salida, nombres[k] + ".stl")
        guardar_stl(pieza, ruta)
        print(f"  {nombres[k]}.stl  {bx1-bx0:.0f} x {by1-by0:.0f} mm  ({pieza.num_tri():,} triángulos)")

    vista_previa(z, forma, W, H, os.path.join(salida, "vista_previa.png"))
    print(f"Listo -> {salida}/")


if __name__ == "__main__":
    main()
