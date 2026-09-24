#!/usr/bin/env python3
"""
LEARNING NOTE: Android app icons and launch screens

Android launchers mask icons into circles, squircles or rounded squares
depending on the phone maker, so since Android 8 an app ships an ADAPTIVE icon:
a full-bleed BACKGROUND layer and a FOREGROUND layer, each 108 dp square, of
which only the central 66 dp circle is guaranteed to be visible. The launcher
masks and may even animate (parallax) the two layers. Android 13 adds a
MONOCHROME layer that the system tints to match the wallpaper ("themed icons").
Older phones still use plain square/round PNGs, one per screen density
(mdpi 1x ... xxxhdpi 4x).

Everything is drawn at 1024 px with numpy/PIL and downsampled, so edges are
anti-aliased at every density. The wordmark uses Rajdhani (SIL OFL), the same
face as the in-game UI.

Run from the apogee/ folder with the asset virtualenv (needs brotli for WOFF2):
    raw-assets/.venv/bin/python tools/android/make_icons.py
"""
from __future__ import annotations

import io
from pathlib import Path

import numpy as np
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
RES = ROOT / "android" / "app" / "src" / "main" / "res"
STORE = ROOT / "android" / "store"
N = 1024

DENSITIES = {"mdpi": 1.0, "hdpi": 1.5, "xhdpi": 2.0, "xxhdpi": 3.0, "xxxhdpi": 4.0}


def font(size: int) -> ImageFont.FreeTypeFont:
    ttf = io.BytesIO()
    f = TTFont(str(ROOT / "raw-assets" / "fonts" / "rajdhani-700-latin.woff2"))
    f.flavor = None
    f.save(ttf)
    ttf.seek(0)
    return ImageFont.truetype(ttf, size)


def radial(size: int, cx: float, cy: float, r: float, inner: tuple[int, int, int], outer: tuple[int, int, int]) -> np.ndarray:
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    t = np.clip(np.hypot(x - cx, y - cy) / r, 0, 1)[..., None]
    t = t * t * (3 - 2 * t)
    return np.array(inner, np.float32) * (1 - t) + np.array(outer, np.float32) * t


def background(size: int = N) -> Image.Image:
    """Deep-space gradient, stars, and Earth's limb glowing at the bottom."""
    img = radial(size, size * 0.5, size * 0.28, size * 0.95, (22, 38, 74), (3, 5, 11))
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    # Earth: a huge circle whose top edge arcs across the lower third
    ecx, ecy, er = size * 0.5, size * 2.05, size * 1.33
    d = np.hypot(x - ecx, y - ecy) - er  # <0 inside Earth
    earth = np.clip(-d / (size * 0.004), 0, 1)[..., None]
    shade = np.clip((y - (ecy - er)) / (size * 0.35), 0, 1)[..., None]
    ocean = np.array((20, 70, 128), np.float32) * (1 - shade) + np.array((6, 20, 40), np.float32) * shade
    img = img * (1 - earth) + ocean * earth
    # Atmosphere rim: thin bright line + soft outer glow
    rim = np.exp(-((d / (size * 0.006)) ** 2))[..., None]
    glow = np.exp(-np.clip(d, 0, None) / (size * 0.05))[..., None] * (d > 0)[..., None]
    img = img + rim * np.array((120, 220, 255), np.float32) * 0.9 + glow * np.array((40, 120, 220), np.float32) * 0.55
    # Stars (deterministic)
    rng = np.random.default_rng(20260924)
    out = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB")
    dr = ImageDraw.Draw(out)
    for _ in range(int(size * 0.09)):
        sx, sy = rng.uniform(0, size), rng.uniform(0, size * 0.62)
        r = rng.choice([0.6, 0.9, 1.3, 2.0], p=[0.5, 0.3, 0.15, 0.05]) * size / 1024
        b = int(rng.uniform(120, 255))
        dr.ellipse([sx - r, sy - r, sx + r, sy + r], fill=(b, b, min(255, b + 20)))
    return out


def rocket_layer(size: int = N, mono: bool = False) -> Image.Image:
    """Rocket climbing up-right on its trajectory arc, drawn inside the 66 dp safe zone."""
    s = size / 1024
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    # Trajectory arc (the ascent path bending over towards orbit)
    arc = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ad = ImageDraw.Draw(arc)
    box = [int(150 * s), int(330 * s), int(1150 * s), int(1330 * s)]
    arc_col = (255, 255, 255, 235) if mono else (120, 225, 255, 230)
    ad.arc(box, start=196, end=262, fill=arc_col, width=max(2, int(20 * s)))
    if not mono:
        arc = Image.alpha_composite(arc.filter(ImageFilter.GaussianBlur(10 * s)), arc)
    layer = Image.alpha_composite(layer, arc)

    # Rocket drawn upright at 4x supersampling in its own canvas, then rotated
    W, H = int(260 * s), int(560 * s)
    rk = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(rk)
    cx = W / 2
    bw = W * 0.30  # body half-width
    top, body_top, body_bot = H * 0.04, H * 0.30, H * 0.72
    body = (255, 255, 255, 255) if mono else (236, 242, 250, 255)
    dark = (255, 255, 255, 255) if mono else (40, 52, 72, 255)
    accent = (255, 255, 255, 255) if mono else (255, 138, 61, 255)
    # Nose (ogive approximated by a polygon)
    # t = 0 at the base of the cone (full width), 1 at the tip
    right = [(cx + bw * (1 - t * t) ** 0.6, body_top - (body_top - top) * t) for t in np.linspace(0, 1, 40)]
    left = [(2 * cx - x, y) for x, y in reversed(right)]
    d.polygon([*right, *left], fill=accent if not mono else body)
    d.rectangle([cx - bw, body_top, cx + bw, body_bot], fill=body)
    if not mono:
        # Window + interstage band + shading
        d.ellipse([cx - bw * 0.42, H * 0.36, cx + bw * 0.42, H * 0.36 + bw * 0.84], fill=(30, 60, 95, 255), outline=(120, 200, 255, 255), width=max(1, int(6 * s)))
        d.rectangle([cx - bw, H * 0.58, cx + bw, H * 0.615], fill=dark)
        d.rectangle([cx + bw * 0.45, body_top, cx + bw, body_bot], fill=(200, 210, 225, 255))
    # Fins
    fin = [(cx - bw, body_bot - H * 0.13), (cx - bw * 2.05, body_bot + H * 0.06), (cx - bw, body_bot)]
    d.polygon(fin, fill=accent)
    d.polygon([(2 * cx - x, y) for x, y in fin], fill=accent)
    # Nozzle
    d.polygon([(cx - bw * 0.5, body_bot), (cx + bw * 0.5, body_bot), (cx + bw * 0.72, body_bot + H * 0.05), (cx - bw * 0.72, body_bot + H * 0.05)], fill=dark)
    if not mono:
        # Flame: layered ellipses, white core → orange → red, then blurred glow
        flame = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        fd = ImageDraw.Draw(flame)
        fy = body_bot + H * 0.05
        for w, l, col in [(0.95, 0.27, (255, 90, 30, 190)), (0.72, 0.21, (255, 160, 60, 230)), (0.42, 0.14, (255, 245, 220, 255))]:
            fd.ellipse([cx - bw * w, fy - H * 0.02, cx + bw * w, fy + H * l], fill=col)
        glow = flame.filter(ImageFilter.GaussianBlur(14 * s))
        rk = Image.alpha_composite(Image.alpha_composite(glow, flame), rk)
    else:
        fd = ImageDraw.Draw(rk)
        fy = body_bot + H * 0.05
        fd.ellipse([cx - bw * 0.6, fy - H * 0.02, cx + bw * 0.6, fy + H * 0.22], fill=(255, 255, 255, 255))
    rk = rk.rotate(-38, resample=Image.BICUBIC, expand=True)
    # Place with its centre on the arc, slightly right of the icon centre
    px = int(size * 0.53 - rk.width / 2)
    py = int(size * 0.47 - rk.height / 2)
    layer.alpha_composite(rk, (px, py))
    return layer


def rounded_mask(size: int, radius: float) -> Image.Image:
    m = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size * 4 - 1, size * 4 - 1], radius=radius * 4, fill=255)
    return m.resize((size, size), Image.LANCZOS)


def circle_mask(size: int) -> Image.Image:
    m = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(m).ellipse([0, 0, size * 4 - 1, size * 4 - 1], fill=255)
    return m.resize((size, size), Image.LANCZOS)


def save(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, optimize=True)


def main() -> None:
    bg = background()
    fg = rocket_layer()
    mono = rocket_layer(mono=True)
    full = Image.alpha_composite(bg.convert("RGBA"), fg)

    # Adaptive icon layers: 108 dp per density
    for dens, k in DENSITIES.items():
        px = int(round(108 * k))
        save(fg.resize((px, px), Image.LANCZOS), RES / f"mipmap-{dens}" / "ic_launcher_foreground.png")
        save(bg.resize((px, px), Image.LANCZOS), RES / f"mipmap-{dens}" / "ic_launcher_background.png")
        save(mono.resize((px, px), Image.LANCZOS), RES / f"mipmap-{dens}" / "ic_launcher_monochrome.png")
        # Legacy icons: 48 dp; the artwork is zoomed so the rocket fills the square
        lp = int(round(48 * k))
        crop = full.crop((int(N * 0.14), int(N * 0.14), int(N * 0.86), int(N * 0.86))).resize((lp, lp), Image.LANCZOS)
        sq = crop.copy()
        sq.putalpha(rounded_mask(lp, lp * 0.18))
        save(sq, RES / f"mipmap-{dens}" / "ic_launcher.png")
        rd = crop.copy()
        rd.putalpha(circle_mask(lp))
        save(rd, RES / f"mipmap-{dens}" / "ic_launcher_round.png")

    for name in ("ic_launcher", "ic_launcher_round"):
        (RES / "mipmap-anydpi-v26" / f"{name}.xml").write_text(
            '<?xml version="1.0" encoding="utf-8"?>\n'
            '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n'
            '    <background android:drawable="@mipmap/ic_launcher_background"/>\n'
            '    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n'
            '    <monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>\n'
            "</adaptive-icon>\n"
        )
    # The template's vector foreground would shadow our PNG on API 24-25
    stale = RES / "drawable-v24" / "ic_launcher_foreground.xml"
    if stale.exists():
        stale.unlink()

    # Play Store listing: 512 px icon (Play applies its own mask) + 1024x500 feature graphic
    save(full.convert("RGB").resize((512, 512), Image.LANCZOS), STORE / "icon-512.png")
    feat = background(1024).crop((0, 262, 1024, 762)).convert("RGBA")
    rk = rocket_layer(600)
    feat.alpha_composite(rk, (440, -40))
    dr = ImageDraw.Draw(feat)
    dr.text((70, 150), "APOGEE", font=font(150), fill=(255, 255, 255, 255))
    dr.text((78, 320), "REAL-SCALE SPACE PROGRAM", font=font(34), fill=(160, 180, 205, 255))
    save(feat.convert("RGB"), STORE / "feature-1024x500.png")

    # Launch screen for Android < 12 (12+ shows the adaptive icon on the theme colour)
    for orient in ("land", "port"):
        for dens, k in DENSITIES.items():
            w, h = (480, 320) if orient == "land" else (320, 480)
            w, h = int(w * k), int(h * k)
            img = Image.new("RGBA", (w, h), (5, 7, 12, 255))
            ic = min(w, h) * 0.42
            img.alpha_composite(full.resize((int(ic), int(ic)), Image.LANCZOS), (int((w - ic) / 2), int(h * 0.5 - ic * 0.62)))
            f = font(int(min(w, h) * 0.085))
            dr = ImageDraw.Draw(img)
            tw = dr.textlength("A P O G E E", font=f)
            dr.text(((w - tw) / 2, h * 0.5 + ic * 0.45), "A P O G E E", font=f, fill=(232, 238, 247, 255))
            save(img.convert("RGB"), RES / f"drawable-{orient}-{dens}" / "splash.png")
    save(Image.new("RGB", (480, 320), (5, 7, 12)), RES / "drawable" / "splash.png")
    print("icons, splash and store graphics written")


if __name__ == "__main__":
    main()
