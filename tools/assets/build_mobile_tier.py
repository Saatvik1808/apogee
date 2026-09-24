#!/usr/bin/env python3
"""
LEARNING NOTE: Texture tiers for phones

A 4096x2048 RGBA texture occupies 32 MB of GPU memory (43 MB with mipmaps), and
the desktop build uploads ten of them. Phones share a few GB of RAM between the
CPU, the GPU and every other app, and the WebView's GPU process is killed long
before that runs out, so mobile devices get a derived "2k" tier: every planet
map at 2048x1024 (a quarter of the memory) and the 1k ground-detail textures at
512 px. Downsampling uses a Lanczos filter; normal maps are re-normalised after
filtering because averaging unit vectors shortens them.

Run from the apogee/ folder after build_assets.py:
    python3 tools/assets/build_mobile_tier.py
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
OUT = Path(__file__).resolve().parents[2] / "public" / "assets"

PLANET_MAPS = [
    # (source, destination, is_normal_map)
    ("earth/day_4k.jpg", "earth/day_2k.jpg", False),
    ("earth/night_4k.jpg", "earth/night_2k.jpg", False),
    ("earth/clouds_4k.jpg", "earth/clouds_2k.jpg", False),
    ("earth/normal_4k.jpg", "earth/normal_2k.jpg", True),
    ("earth/coast_sdf_4k.png", "earth/coast_sdf_2k.png", False),
    ("moon/color_4k.jpg", "moon/color_2k.jpg", False),
    ("moon/normal_4k.jpg", "moon/normal_2k.jpg", True),
    ("mars/color_4k.jpg", "mars/color_2k.jpg", False),
    ("mars/normal_4k.jpg", "mars/normal_2k.jpg", True),
    ("sky/milkyway_4k.jpg", "sky/milkyway_2k.jpg", False),
]
PBR = ["grass", "sand", "concrete", "rock", "regolith"]


def renormalize(img: Image.Image) -> Image.Image:
    a = np.asarray(img.convert("RGB"), dtype=np.float32) / 127.5 - 1.0
    n = np.linalg.norm(a, axis=2, keepdims=True)
    a = a / np.maximum(n, 1e-6)
    return Image.fromarray(np.clip((a + 1.0) * 127.5 + 0.5, 0, 255).astype(np.uint8))


def save(img: Image.Image, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.suffix == ".png":
        img.save(dst, optimize=True)
    else:
        img.convert("RGB").save(dst, quality=88, optimize=True, progressive=False)
    print(f"wrote {dst.relative_to(OUT.parent.parent)} {img.size[0]}x{img.size[1]} {dst.stat().st_size:,} B")


def main() -> None:
    for src_rel, dst_rel, normal in PLANET_MAPS:
        src = Image.open(OUT / src_rel)
        mode = "L" if src.mode in ("L", "I;16") else src.mode
        img = src.convert(mode) if mode != src.mode else src
        w, h = img.size
        out = img.resize((w // 2, h // 2), Image.LANCZOS)
        if normal:
            out = renormalize(out)
        save(out, OUT / dst_rel)
    for name in PBR:
        for kind in ("diff", "nor", "rough"):
            src = Image.open(OUT / f"pbr/{name}_{kind}.jpg")
            out = src.resize((src.size[0] // 2, src.size[1] // 2), Image.LANCZOS)
            if kind == "nor":
                out = renormalize(out)
            save(out, OUT / f"pbr/{name}_{kind}_512.jpg")


if __name__ == "__main__":
    main()
