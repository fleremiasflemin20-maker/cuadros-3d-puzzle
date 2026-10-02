#!/usr/bin/env python3
"""
Genera las piezas en baja resolución para el visor 3D de la landing (index.html).

Formato .bin por pieza (little endian):
  uint32 n_vertices, uint32 n_triangulos,
  int16[n_vertices*3] posiciones en décimas de mm,
  uint16[n_triangulos*3] índices

Uso: .venv/bin/python herramientas/piezas_web.py ejemplos/mandala.png
"""
import json
import math
import os
import struct
import sys

import numpy as np
from PIL import Image, ImageOps

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import cuadro_puzzle as cp


def main():
    sys.argv = [sys.argv[0], sys.argv[1], "--res", "2.5"]
    a = cp.leer_args()
    with Image.open(a.imagen) as im:
        aspecto = ImageOps.exif_transpose(im).height / im.width
    W, H = a.ancho, round(a.ancho * aspecto, 1)
    nx, ny = int(round(W / a.res)) + 1, int(round(H / a.res)) + 1
    rx, ry = W / (nx - 1), H / (ny - 1)
    z = cp.mapa_alturas(a, W, H, nx, ny)
    forma, _ = cp.contornos(W, H, a.holgura)
    nombres = {(0, 1): "A", (1, 1): "B", (0, 0): "C", (1, 0): "D"}
    os.makedirs("assets/piezas", exist_ok=True)
    for k, cs in forma.items():
        bx0, by0, bx1, by1 = cs.bounds()
        i0, i1 = max(0, math.floor(bx0 / rx) - 1), min(nx - 1, math.ceil(bx1 / rx) + 1)
        j0, j1 = max(0, math.floor(by0 / ry) - 1), min(ny - 1, math.ceil(by1 / ry) + 1)
        slab = cp.losa(z[j0:j1 + 1, i0:i1 + 1], 0, 0, 1).scale((rx, ry, 1)).translate((i0 * rx, j0 * ry, 0))
        m = (slab ^ cs.extrude(float(z.max()) + 1)).to_mesh()
        v = np.asarray(m.vert_properties)[:, :3]
        t = np.asarray(m.tri_verts)
        v = np.round((v - [W / 2, H / 2, 0]) * 10).astype("<i2")  # centrado en el cuadro
        with open(f"assets/piezas/{nombres[k]}.bin", "wb") as f:
            f.write(struct.pack("<II", len(v), len(t)))
            f.write(v.tobytes())
            f.write(t.astype("<u2").tobytes())
        print(nombres[k], len(v), "vértices", len(t), "triángulos")
    with open("assets/piezas/info.json", "w") as f:
        json.dump({"ancho": W, "alto": H}, f)


if __name__ == "__main__":
    main()
