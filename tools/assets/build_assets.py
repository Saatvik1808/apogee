#!/usr/bin/env python3
"""
APOGEE asset pipeline:  raw-assets/  ->  public/assets/

LEARNING NOTE: Planet textures here are *equirectangular* (plate carree) maps:
x is longitude, y is latitude, so a W x H image with W = 2H covers the whole sphere
with square pixels in angle space. Heights are packed into 8-bit RGB PNGs
(R = high byte, G = low byte of a 16-bit integer) because browsers decode 8-bit PNGs
byte-exactly, whereas 16-bit PNGs get truncated to 8 bits on the way to WebGL.
Normal maps are stored in the local East-North-Up (ENU) frame so a shader can rotate
them onto the sphere with a tangent basis (east = d/dlon, north = d/dlat, up = radial).
Because the east distance of one pixel shrinks with cos(latitude), slopes are computed
in metres per metre, not per pixel - otherwise mountains near the poles would look
absurdly steep. Downsampling uses area averaging (BOX) for physical quantities such
as height, and Lanczos for photographs.
Key concepts: equirectangular projection, area-averaged resampling, packed height
maps, ENU tangent frame, even-odd polygon rasterisation, spectral (FFT) ocean waves.
Further reading: https://en.wikipedia.org/wiki/Equirectangular_projection

Conventions (the game's shaders depend on them)
  * Planet maps: width = 2*height, column 0 = longitude -180, centre column = 0,
    longitude increases EASTWARD to the right, row 0 = latitude +90.
  * 16-bit packed height PNG: u16 = round((h_m + 10000) / 0.5) clamped to [0, 65535],
    R = u16 >> 8, G = u16 & 255, B = 0, no alpha, no gAMA/sRGB/iCCP chunks.
  * ENU normal JPG: n = normalize(-E*dh/dx_east, -E*dh/dy_north, 1) (slopes in m/m),
    RGB = round((n*0.5 + 0.5)*255). Height is area-averaged to the output grid FIRST,
    then differentiated with central differences (one-sided at the pole rows; pole
    guard: the east difference spans +-round(1/cos(lat)) columns, see enu_normal_rgb).
  * Milky Way: equatorial J2000, column u in [0,1) <-> RA = u*360 deg (RA 0h at the
    LEFT edge, increasing to the right), row v <-> Dec = 90 - v*180 deg.
  * sky/stars.json: metadata + "data" = base64 of little-endian float32 records
    (x, y, z, vmag, bv) with x = cos(dec)cos(ra), y = sin(dec), z = -cos(dec)sin(ra);
    sorted by vmag.
  * Binary files ship base64-packed in JSON ({..., "bytes": n, "data": "<base64>"}) because
    the game is also published on a static host that only serves web media types
    (no .bin/.hdr); the loader unpacks them (fetchPacked in src/render/Assets.ts).

Usage (run from the apogee/ folder):
    python3 -m venv raw-assets/.venv
    raw-assets/.venv/bin/pip install numpy pillow scipy tifffile imagecodecs OpenEXR
    raw-assets/.venv/bin/python tools/assets/build_assets.py --download   # fetch missing raw files
    raw-assets/.venv/bin/python tools/assets/build_assets.py              # build everything + verify
    raw-assets/.venv/bin/python tools/assets/build_assets.py --only moon,mars
    raw-assets/.venv/bin/python tools/assets/build_assets.py --verify-only
  Peak RAM ~4 GB (Earth terrain works on the 21600x10800 ETOPO grid). Runtime ~30 s (M-series Mac).

Raw sources (downloaded into raw-assets/<path>; ~1.6 GB total):
  earth/world.topo.bathy.200409.3x21600x10800.jpg  https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73801/world.topo.bathy.200409.3x21600x10800.jpg
  earth/BlackMarble_2016_3km_gray.jpg              https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144897/BlackMarble_2016_3km_gray.jpg
  earth/cloud_combined_8192.tif                    https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_8192.tif
  earth/ETOPO_2022_v1_60s_N90W180_surface.tif      https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/60s_surface_elev_gtif/ETOPO_2022_v1_60s_N90W180_surface.tif
  earth/ne_10m_land.geojson                        https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson
  earth/ne_10m_lakes.geojson                       https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_lakes.geojson
  earth/ne_10m_antarctic_ice_shelves_polys.geojson https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_antarctic_ice_shelves_polys.geojson
  moon/lroc_color_poles_8k.tif                     https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_8k.tif
  moon/ldem_16.tif                                 https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_16.tif
  mars/Mars_Viking_ClrMosaic_global_925m.tif       https://planetarymaps.usgs.gov/mosaic/Mars_Viking_ClrMosaic_global_925m.tif
  mars/Mars_Viking_ClrMosaic_global_925m.lbl       https://planetarymaps.usgs.gov/mosaic/Mars_Viking_ClrMosaic_global_925m.lbl
  mars/megt90n000eb.img                            https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg016/megt90n000eb.img
  mars/megt90n000eb.lbl                            https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg016/megt90n000eb.lbl
  sky/hygdata_v41.csv                              https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv
  sky/milkyway_2020_4k.exr                         https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/milkyway_2020_4k.exr
  pbr/<id>_{diff,nor_gl,rough}_1k.png              https://dl.polyhaven.org/file/ph-assets/Textures/png/1k/<id>/<id>_<map>_1k.png
        ids: rocky_terrain_02 (grass), aerial_beach_01 (sand), large_floor_tiles_02 (concrete),
             rock_ground_02 (rock), moon_02 (regolith)
  hdri/empty_warehouse_01_{1k,2k}.hdr              https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/<res>/empty_warehouse_01_<res>.hdr
  noise/LDR_LLL1_0_128.png                         https://raw.githubusercontent.com/Calinou/free-blue-noise-textures/master/128_128/LDR_LLL1_0.png
  fonts/*.woff2  latin subsets from Google Fonts (css2 API queried with a Chrome User-Agent):
        https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700
        https://fonts.googleapis.com/css2?family=Inter:wght@400..600
        https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400..600
        (resolved gstatic URLs are in SOURCES below); OFL texts from github.com/google/fonts/tree/main/ofl
"""
from __future__ import annotations

import argparse
import base64
import csv
import json
import math
import re
import shutil
import struct
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None  # the source maps are intentionally huge

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "raw-assets"
OUT = ROOT / "public" / "assets"

R_EARTH = 6_371_000.0   # mean radius (m) used for slope computation
R_MOON = 1_737_400.0    # LOLA reference sphere
R_MARS = 3_396_000.0    # MOLA MEGDR reference radius (areoid mean equatorial radius)

H_OFFSET, H_STEP = 10000.0, 0.5   # packed height encoding

# ----------------------------------------------------------------------------- sources
NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson"
SVS_MOON = "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720"
SVS_SKY = "https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851"
PH_TEX = "https://dl.polyhaven.org/file/ph-assets/Textures/png/1k"
PH_HDRI = "https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr"
GSTATIC = "https://fonts.gstatic.com/s"
GF_OFL = "https://raw.githubusercontent.com/google/fonts/main/ofl"

# output set name -> (Poly Haven id, author credit)
PBR_SETS = {
    "grass": ("rocky_terrain_02", "Amal Kumar"),
    "sand": ("aerial_beach_01", "Rob Tuytel"),
    "concrete": ("large_floor_tiles_02", "Rob Tuytel"),
    "rock": ("rock_ground_02", "Rob Tuytel"),
    "regolith": ("moon_02", "Greg Zaal, Rico Cilliers, Jenelle van Heerden (photography), Dario Barresi (processing)"),
}
PBR_MAPS = {"diff": "diff", "nor": "nor_gl", "rough": "rough"}  # output suffix -> Poly Haven map
HDRI_ID = "empty_warehouse_01"

# output font file -> (raw file, url)
FONTS = {
    "rajdhani-500.woff2": ("fonts/rajdhani-500-latin.woff2", f"{GSTATIC}/rajdhani/v17/LDI2apCSOBg7S-QT7pb0EPOreefkkbIx.woff2"),
    "rajdhani-600.woff2": ("fonts/rajdhani-600-latin.woff2", f"{GSTATIC}/rajdhani/v17/LDI2apCSOBg7S-QT7pbYF_OreefkkbIx.woff2"),
    "rajdhani-700.woff2": ("fonts/rajdhani-700-latin.woff2", f"{GSTATIC}/rajdhani/v17/LDI2apCSOBg7S-QT7pa8FvOreefkkbIx.woff2"),
    "inter-var.woff2": ("fonts/inter-var-latin.woff2", f"{GSTATIC}/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.woff2"),
    "jetbrains-mono-var.woff2": ("fonts/jetbrainsmono-var-latin.woff2",
                                 f"{GSTATIC}/jetbrainsmono/v24/tDbv2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKwBNntkaToggR7BYRbKPxDcwgknk-4.woff2"),
    "OFL-Rajdhani.txt": ("fonts/OFL-Rajdhani.txt", f"{GF_OFL}/rajdhani/OFL.txt"),
    "OFL-Inter.txt": ("fonts/OFL-Inter.txt", f"{GF_OFL}/inter/OFL.txt"),
    "OFL-JetBrainsMono.txt": ("fonts/OFL-JetBrainsMono.txt", f"{GF_OFL}/jetbrainsmono/OFL.txt"),
}

SOURCES: list[tuple[str, str]] = [
    ("earth/world.topo.bathy.200409.3x21600x10800.jpg",
     "https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73801/world.topo.bathy.200409.3x21600x10800.jpg"),
    ("earth/BlackMarble_2016_3km_gray.jpg",
     "https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144897/BlackMarble_2016_3km_gray.jpg"),
    ("earth/cloud_combined_8192.tif",
     "https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_8192.tif"),
    ("earth/ETOPO_2022_v1_60s_N90W180_surface.tif",
     "https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO2022/data/60s/60s_surface_elev_gtif/ETOPO_2022_v1_60s_N90W180_surface.tif"),
    ("earth/ne_10m_land.geojson", f"{NE}/ne_10m_land.geojson"),
    ("earth/ne_10m_lakes.geojson", f"{NE}/ne_10m_lakes.geojson"),
    ("earth/ne_10m_antarctic_ice_shelves_polys.geojson", f"{NE}/ne_10m_antarctic_ice_shelves_polys.geojson"),
    ("moon/lroc_color_poles_8k.tif", f"{SVS_MOON}/lroc_color_poles_8k.tif"),
    ("moon/ldem_16.tif", f"{SVS_MOON}/ldem_16.tif"),
    ("mars/Mars_Viking_ClrMosaic_global_925m.lbl", "https://planetarymaps.usgs.gov/mosaic/Mars_Viking_ClrMosaic_global_925m.lbl"),
    ("mars/Mars_Viking_ClrMosaic_global_925m.tif", "https://planetarymaps.usgs.gov/mosaic/Mars_Viking_ClrMosaic_global_925m.tif"),
    ("mars/megt90n000eb.lbl", "https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg016/megt90n000eb.lbl"),
    ("mars/megt90n000eb.img", "https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg016/megt90n000eb.img"),
    ("sky/hygdata_v41.csv", "https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv"),
    ("sky/milkyway_2020_4k.exr", f"{SVS_SKY}/milkyway_2020_4k.exr"),
    (f"hdri/{HDRI_ID}_1k.hdr", f"{PH_HDRI}/1k/{HDRI_ID}_1k.hdr"),
    (f"hdri/{HDRI_ID}_2k.hdr", f"{PH_HDRI}/2k/{HDRI_ID}_2k.hdr"),
    ("noise/LDR_LLL1_0_128.png", "https://raw.githubusercontent.com/Calinou/free-blue-noise-textures/master/128_128/LDR_LLL1_0.png"),
]
SOURCES += [(f"pbr/{pid}_{m}_1k.png", f"{PH_TEX}/{pid}/{pid}_{m}_1k.png")
            for pid, _ in PBR_SETS.values() for m in PBR_MAPS.values()]
SOURCES += [(rawrel, url) for rawrel, url in FONTS.values()]


def download_sources(force: bool = False) -> None:
    for rel, url in SOURCES:
        dst = RAW / rel
        if dst.exists() and dst.stat().st_size > 0 and not force:
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        log(f"download {url}")
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (apogee-asset-build)"})
        tmp = dst.with_name(dst.name + ".part")
        with urllib.request.urlopen(req, timeout=300) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f, 1 << 20)
        tmp.replace(dst)


# ----------------------------------------------------------------------------- utilities
STATS: dict = {}


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def raw(rel: str) -> Path:
    p = RAW / rel
    if not p.exists():
        sys.exit(f"missing raw file {p} - run with --download")
    return p


def out(rel: str) -> Path:
    p = OUT / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def write_packed(rel: str, data: bytes, meta: dict) -> Path:
    """Writes `data` base64-packed into a JSON file together with its metadata."""
    p = out(rel)
    doc = {**meta, "bytes": len(data), "data": base64.b64encode(data).decode("ascii")}
    p.write_text(json.dumps(doc, separators=(",", ":")) + "\n")
    return p


def read_packed(rel: str) -> tuple[dict, bytes]:
    doc = json.loads((OUT / rel).read_text())
    data = base64.b64decode(doc.pop("data"))
    assert len(data) == doc["bytes"], rel
    return doc, data


def save_jpeg(arr: np.ndarray, rel: str, quality: int, subsampling: int = 2) -> Path:
    """Write a gray (HxW) or RGB (HxWx3) uint8 array as a metadata-free JPEG.
    subsampling: 2 = 4:2:0 (photos), 0 = 4:4:4 (normal maps)."""
    assert arr.dtype == np.uint8
    im = Image.fromarray(np.ascontiguousarray(arr))
    p = out(rel)
    try:
        im.save(p, "JPEG", quality=quality, subsampling=subsampling, optimize=True)
    except OSError:  # Pillow's optimize buffer is W*H bytes; very noisy images can exceed it
        im.save(p, "JPEG", quality=quality, subsampling=subsampling, optimize=False)
    log(f"wrote {p.relative_to(ROOT)} {im.size[0]}x{im.size[1]} {im.mode} {p.stat().st_size:,} B")
    return p


def png_chunk_types(path: Path) -> list[bytes]:
    data = Path(path).read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", path
    i, types = 8, []
    while i < len(data):
        n = struct.unpack(">I", data[i:i + 4])[0]
        types.append(data[i + 4:i + 8])
        i += 12 + n
    return types


def save_png(arr: np.ndarray, rel: str) -> Path:
    """Write uint8 gray/RGB PNG with only IHDR/IDAT/IEND chunks (byte-exact decode)."""
    assert arr.dtype == np.uint8
    im = Image.fromarray(np.ascontiguousarray(arr))
    p = out(rel)
    im.save(p, "PNG", optimize=True)
    bad = set(png_chunk_types(p)) - {b"IHDR", b"IDAT", b"IEND"}
    assert not bad, f"{p}: unexpected PNG chunks {bad}"
    log(f"wrote {p.relative_to(ROOT)} {im.size[0]}x{im.size[1]} {im.mode} {p.stat().st_size:,} B")
    return p


def resize_f32(a: np.ndarray, size: tuple[int, int], resample=Image.BOX, box=None) -> np.ndarray:
    """Resample a float array with PIL (BOX = exact area average for downsampling)."""
    im = Image.fromarray(np.ascontiguousarray(a, dtype=np.float32))
    return np.array(im.resize(size, resample=resample, box=box), dtype=np.float32)  # writable copy


def resize_u8(a: np.ndarray, size: tuple[int, int], resample=Image.LANCZOS, box=None) -> np.ndarray:
    im = Image.fromarray(np.ascontiguousarray(a))
    return np.array(im.resize(size, resample=resample, box=box))


def pack_height(h_m: np.ndarray, rel: str) -> np.ndarray:
    u = np.clip(np.rint((h_m.astype(np.float64) + H_OFFSET) / H_STEP), 0, 65535).astype(np.uint16)
    rgb = np.zeros(h_m.shape + (3,), np.uint8)
    rgb[..., 0] = (u >> 8).astype(np.uint8)
    rgb[..., 1] = (u & 0xFF).astype(np.uint8)
    save_png(rgb, rel)
    return u


def unpack_height_png(path: Path) -> np.ndarray:
    a = np.asarray(Image.open(path))
    assert a.ndim == 3 and a.shape[2] == 3 and a.dtype == np.uint8 and not a[..., 2].any()
    return (a[..., 0].astype(np.float64) * 256 + a[..., 1]) * H_STEP - H_OFFSET


def enu_normal_rgb(h: np.ndarray, radius: float, exaggeration: float,
                   flat: np.ndarray | None = None) -> np.ndarray:
    """ENU normal map (uint8 RGB) from an equirectangular height grid in metres.

    East slope: central difference over +-k columns (wrapping in longitude) with
    k = round(1/cos(lat)) (1 below ~48 deg), so the east baseline stays ~one pixel
    height in metres. This is the pole guard: near the poles an equirectangular row is
    hugely oversampled in longitude and a 1-column difference would turn tiny
    resampling noise into huge slopes (k is capped at W/8)."""
    H, W = h.shape
    h = h.astype(np.float64)
    lat = np.deg2rad(90.0 - (np.arange(H) + 0.5) * 180.0 / H)
    cosl = np.cos(lat)
    dy = math.pi * radius / H                                   # metres per row (north-south)
    dx = (2.0 * math.pi * radius / W) * cosl                    # metres per column at each row
    k = np.clip(np.rint(1.0 / np.maximum(cosl, 1e-9)), 1, W // 8).astype(np.int64)
    dh_east = np.empty_like(h)
    for kk in np.unique(k):
        rows = k == kk
        sub = h[rows]
        dh_east[rows] = (np.roll(sub, -kk, axis=1) - np.roll(sub, kk, axis=1)) / (2.0 * kk * dx[rows][:, None])
    north = np.concatenate([h[:1], h[:-1]])   # row-1 (clamped at the north pole row)
    south = np.concatenate([h[1:], h[-1:]])   # row+1 (clamped at the south pole row)
    span = np.full(H, 2.0 * dy)
    span[0] = span[-1] = dy                   # one-sided differences on the pole rows
    dh_north = (north - south) / span[:, None]
    nx, ny = -exaggeration * dh_east, -exaggeration * dh_north
    inv = 1.0 / np.sqrt(nx * nx + ny * ny + 1.0)
    n = np.stack([nx * inv, ny * inv, inv], axis=-1)
    if flat is not None:
        n[flat] = (0.0, 0.0, 1.0)
    return np.clip(np.rint((n * 0.5 + 0.5) * 255.0), 0, 255).astype(np.uint8)


def px(lon: float, lat: float, W: int, H: int) -> tuple[int, int]:
    """(col,row) of the pixel containing lon/lat in the project convention."""
    c = int(math.floor((lon + 180.0) / 360.0 * W)) % W
    r = min(max(int(math.floor((90.0 - lat) / 180.0 * H)), 0), H - 1)
    return c, r


def ang_mean(img: np.ndarray, lon: float, lat: float, r_out: float, r_in: float = 0.0) -> float:
    """Mean of img over pixels whose angular distance (deg) from lon/lat is in [r_in, r_out)."""
    H, W = img.shape[:2]
    c, r = px(lon, lat, W, H)
    dr = int(math.ceil(r_out / 180.0 * H)) + 1
    rows = np.arange(max(r - dr, 0), min(r + dr + 1, H))
    lat_r = np.deg2rad(90.0 - (rows + 0.5) * 180.0 / H)
    cmin = max(math.cos(math.radians(abs(lat)) + math.radians(r_out)), 1e-3)
    dc = min(int(math.ceil(r_out / 360.0 * W / cmin)) + 1, W // 2)
    cols = np.arange(c - dc, c + dc + 1) % W
    lon_c = np.deg2rad(-180.0 + (cols + 0.5) * 360.0 / W)
    la0, lo0 = math.radians(lat), math.radians(lon)
    d = np.arccos(np.clip(np.sin(la0) * np.sin(lat_r)[:, None]
                          + np.cos(la0) * np.cos(lat_r)[:, None] * np.cos(lon_c[None, :] - lo0), -1, 1))
    m = (d >= math.radians(r_in)) & (d < math.radians(r_out))
    sub = img[np.ix_(rows, cols)]
    return float(sub[m].mean())


def luminance(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., :3].astype(np.float32) @ np.array([0.2126, 0.7152, 0.0722], np.float32)


# ----------------------------------------------------------------------------- polygon raster
def rasterize_evenodd(rings, W: int, H: int, window: tuple[int, int, int, int] | None = None) -> np.ndarray:
    """Even-odd point-in-polygon test for the pixel centres of the global W x H
    equirectangular grid (pixel (r,c) centre = lon -180+(c+.5)*360/W, lat 90-(r+.5)*180/H).
    `rings` = iterable of [[lon, lat], ...]. Exterior rings and holes are treated alike
    (even-odd), so holes and islands-in-lakes come out right. window=(r0, c0, h, w).
    Exact (no vertex rounding): each edge toggles the parity of everything to the right
    of its crossing on every pixel-centre scanline it spans (half-open [ymin, ymax))."""
    r0, c0, hh, ww = window or (0, 0, H, W)
    flat_idx = []
    for ring in rings:
        a = np.asarray(ring, dtype=np.float64)[:, :2]
        if len(a) < 3:
            continue
        if not np.array_equal(a[0], a[-1]):
            a = np.vstack([a, a[:1]])
        x = (a[:, 0] + 180.0) * (W / 360.0) - 0.5 - c0
        y = (90.0 - a[:, 1]) * (H / 180.0) - 0.5 - r0
        xa, ya, xb, yb = x[:-1], y[:-1], x[1:], y[1:]
        lo, hi = np.minimum(ya, yb), np.maximum(ya, yb)
        rs = np.clip(np.ceil(lo), 0, hh).astype(np.int64)
        re_ = np.clip(np.ceil(hi), 0, hh).astype(np.int64)
        n = re_ - rs
        keep = n > 0
        if not keep.any():
            continue
        e = np.nonzero(keep)[0]
        cnt = n[e]
        tot = int(cnt.sum())
        rows = np.arange(tot) - np.repeat(np.cumsum(cnt) - cnt, cnt) + np.repeat(rs[e], cnt)
        ee = np.repeat(e, cnt)
        t = (rows - ya[ee]) / (yb[ee] - ya[ee])
        xi = xa[ee] + t * (xb[ee] - xa[ee])
        col = np.floor(xi).astype(np.int64) + 1          # first pixel centre strictly right of crossing
        ok = col <= ww - 1
        col = np.clip(col[ok], 0, ww)
        flat_idx.append(rows[ok] * (ww + 1) + col)
    toggle = np.zeros(hh * (ww + 1), np.uint8)
    if flat_idx:
        idx, counts = np.unique(np.concatenate(flat_idx), return_counts=True)
        toggle[idx] = (counts & 1).astype(np.uint8)
    inside = np.bitwise_xor.accumulate(toggle.reshape(hh, ww + 1), axis=1)[:, :ww]
    return inside.astype(bool)


def geo_polygons(path: Path):
    """Yield (feature, [ring, ...]) for every polygon in a GeoJSON file."""
    for f in json.loads(Path(path).read_text())["features"]:
        g = f.get("geometry")
        if not g:
            continue
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        for poly in polys:
            yield f, poly


def ring_area_km2(ring) -> float:
    a = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        a += math.radians(x2 - x1) * (2 + math.sin(math.radians(y1)) + math.sin(math.radians(y2)))
    return abs(a) * 6371.0 ** 2 / 2.0


# ============================================================================= EARTH
def build_earth_day() -> None:
    log("earth/day: Blue Marble NG topo+bathy Sep 2004 (21600x10800) -> 8k/4k Lanczos")
    src = Image.open(raw("earth/world.topo.bathy.200409.3x21600x10800.jpg")).convert("RGB")
    assert src.size == (21600, 10800), src.size
    for W, name in ((8192, "day_8k.jpg"), (4096, "day_4k.jpg")):
        save_jpeg(np.asarray(src.resize((W, W // 2), Image.LANCZOS)), f"earth/{name}", 88)


def build_earth_night() -> None:
    log("earth/night: Black Marble 2016 gray 3 km (13500x6750) -> 4k Lanczos")
    src = Image.open(raw("earth/BlackMarble_2016_3km_gray.jpg")).convert("L")
    assert src.size == (13500, 6750), src.size
    save_jpeg(np.asarray(src.resize((4096, 2048), Image.LANCZOS)), "earth/night_4k.jpg", 90)


def build_earth_clouds() -> None:
    import tifffile
    log("earth/clouds: Blue Marble cloud_combined_8192.tif -> gray 8k + 4k")
    a = tifffile.imread(raw("earth/cloud_combined_8192.tif"))
    assert a.shape == (4096, 8192, 3) and a.dtype == np.uint8, a.shape
    spread = int(np.abs(a.astype(np.int16) - a[..., :1]).max())
    STATS["clouds_channel_spread"] = spread
    g = a[..., 0] if spread == 0 else np.rint(luminance(a)).clip(0, 255).astype(np.uint8)
    save_jpeg(g, "earth/clouds_8k.jpg", 88)
    save_jpeg(resize_u8(g, (4096, 2048), Image.LANCZOS), "earth/clouds_4k.jpg", 88)


LAKE_MIN_KM2 = 1000.0     # only lakes that survive at ~10 km/px
ALKALINE_MAX_LUMA = 90.0  # NE "Alkaline Lake" polygons count as water only if dark in the Sep 2004 Blue Marble
                          # (drops dry salt pans such as Eyre, Torrens, Gairdner, Tuz; keeps Issyk-Kul, Van, ...)
LAKE_LEVEL_PCT = 10.0     # lake surface = this percentile of land elevation in a 2-px shore ring
COAST_BAND_PX = 3         # land within this many 1' px of the ocean is clamped to h >= 0


def build_earth_terrain() -> None:
    import tifffile
    from scipy import ndimage

    W0, H0 = 21600, 10800
    log("earth/terrain: loading ETOPO 2022 60 arc-second surface elevation")
    h = tifffile.imread(raw("earth/ETOPO_2022_v1_60s_N90W180_surface.tif"))
    assert h.shape == (H0, W0) and h.dtype == np.float32, (h.shape, h.dtype)
    assert not (h < -20000).any(), "nodata in ETOPO"
    STATS["etopo_min_m"], STATS["etopo_max_m"] = float(h.min()), float(h.max())

    log("earth/terrain: rasterising Natural Earth 10m land + Antarctic ice shelves (even-odd, pixel centres)")
    land = rasterize_evenodd((ring for _, poly in geo_polygons(raw("earth/ne_10m_land.geojson")) for ring in poly), W0, H0)
    shelves = rasterize_evenodd((ring for _, poly in geo_polygons(raw("earth/ne_10m_antarctic_ice_shelves_polys.geojson"))
                                 for ring in poly), W0, H0)
    STATS["ice_shelf_px_added"] = int((shelves & ~land).sum())
    land |= shelves
    del shelves

    # --- conditioned elevation, step 1: ETOPO/NE coastline mismatch -> land next to the ocean is >= 0 m
    ocean = ~land
    near_ocean = ndimage.binary_dilation(ocean, iterations=COAST_BAND_PX)
    fix = near_ocean & land & (h < 0)
    STATS["coastal_negative_px_clamped"] = int(fix.sum())
    h[fix] = 0.0
    del fix, near_ocean
    h[ocean] = 0.0
    # Polar land never lies below sea level; negative ETOPO values there are bathymetry under
    # floating ice (NE ice shelves that have since collapsed, e.g. Larsen B / Mertz, and Greenland
    # fjords under glacier tongues) -> clamp to sea level so they don't become pits.
    polar_rows = np.abs(90.0 - (np.arange(H0) + 0.5) * 180.0 / H0) >= 60.0
    sub = h[polar_rows]
    neg = (sub < 0) & land[polar_rows]
    STATS["polar_negative_px_clamped"] = int(neg.sum())
    sub[neg] = 0.0
    h[polar_rows] = sub
    del sub, neg

    # --- large lakes: NE 10m polygons >= LAKE_MIN_KM2 (alkaline ones only if they look like water)
    log("earth/terrain: selecting large lakes")
    bm = Image.open(raw("earth/world.topo.bathy.200409.3x21600x10800.jpg")).convert("L")
    luma = np.asarray(bm)
    del bm
    feats: dict[int, dict] = {}
    for f, poly in geo_polygons(raw("earth/ne_10m_lakes.geojson")):
        d = feats.setdefault(id(f), {"name": f["properties"].get("name") or "?", "cls": f["properties"]["featurecla"],
                                     "rings": [], "area": 0.0})
        d["rings"] += poly
        d["area"] += ring_area_km2(poly[0]) - sum(ring_area_km2(hr) for hr in poly[1:])
    lake_id = np.zeros((H0, W0), np.uint16)
    lakes, rejected = [], []
    for d in sorted(feats.values(), key=lambda d: -d["area"]):
        if d["area"] < LAKE_MIN_KM2:
            continue
        allpts = np.concatenate([np.asarray(r, np.float64)[:, :2] for r in d["rings"]])
        c0 = max(int((allpts[:, 0].min() + 180.0) * W0 / 360.0) - 4, 0)
        c1 = min(int((allpts[:, 0].max() + 180.0) * W0 / 360.0) + 5, W0)
        r0 = max(int((90.0 - allpts[:, 1].max()) * H0 / 180.0) - 4, 0)
        r1 = min(int((90.0 - allpts[:, 1].min()) * H0 / 180.0) + 5, H0)
        win = (r0, c0, r1 - r0, c1 - c0)
        m = rasterize_evenodd(d["rings"], W0, H0, window=win) & land[r0:r1, c0:c1]
        m &= lake_id[r0:r1, c0:c1] == 0
        if not m.any():
            continue
        L = float(luma[r0:r1, c0:c1][m].mean())
        d.update(win=win, luma=L)
        if d["cls"] == "Alkaline Lake" and L > ALKALINE_MAX_LUMA:
            rejected.append(d)
            continue
        lakes.append(d)
        lake_id[r0:r1, c0:c1][m] = len(lakes)
    del luma
    lakemask = lake_id > 0
    # shore level: low percentile of land (non-lake) elevation in a 2-pixel ring around each lake
    for k, d in enumerate(lakes, 1):
        r0, c0, hh, ww = d["win"]
        m = lake_id[r0:r0 + hh, c0:c0 + ww] == k
        ring = ndimage.binary_dilation(m, iterations=2) & ~m & land[r0:r0 + hh, c0:c0 + ww] & ~lakemask[r0:r0 + hh, c0:c0 + ww]
        vals = h[r0:r0 + hh, c0:c0 + ww][ring]
        d["level"] = max(float(np.percentile(vals, LAKE_LEVEL_PCT)), 0.0) if vals.size else 0.0
    STATS["lakes"] = [(d["name"], round(d["area"]), round(d["luma"], 1), round(d["level"], 1)) for d in lakes]
    STATS["lakes_rejected_bright"] = [(d["name"], round(d["area"]), round(d["luma"], 1)) for d in rejected]
    log(f"earth/terrain: {len(lakes)} lakes kept, {len(rejected)} alkaline lakes rejected as dry/bright")

    # --- conditioned elevation, step 2: lakes are flat at their estimated surface level
    for k, d in enumerate(lakes, 1):
        r0, c0, hh, ww = d["win"]
        sub = h[r0:r0 + hh, c0:c0 + ww]
        sub[lake_id[r0:r0 + hh, c0:c0 + ww] == k] = d["level"]
    del lake_id
    land_dry = land & ~lakemask
    STATS["earth_land_min_m"] = float(h[land_dry].min())
    STATS["earth_land_max_m"] = float(h[land_dry].max())

    log("earth/terrain: area-averaging to 4096x2048 and 2048x1024")
    h4 = resize_f32(h, (4096, 2048))
    h2 = resize_f32(h, (2048, 1024))
    del h
    oc = ocean.astype(np.float32)
    del ocean
    oc4, oc2 = resize_f32(oc, (4096, 2048)), resize_f32(oc, (2048, 1024))
    del oc
    lk = lakemask.astype(np.float32)
    del lakemask, land, land_dry
    lk4, lk2 = resize_f32(lk, (4096, 2048)), resize_f32(lk, (2048, 1024))
    del lk

    water4 = (oc4 + lk4) >= 0.5
    ocean4 = water4 & (oc4 >= lk4)
    h4[ocean4] = 0.0
    h4[water4] = np.maximum(h4[water4], 0.0)
    v = np.where(water4, 0, 1 + np.rint(254.0 * np.sqrt(np.clip(h4, 0.0, 8850.0) / 8850.0)))
    save_png(v.astype(np.uint8), "earth/topo_4k.png")
    save_jpeg(enu_normal_rgb(h4, R_EARTH, 6.0, flat=water4), "earth/normal_4k.jpg", 92, subsampling=0)

    water2 = (oc2 + lk2) >= 0.5
    ocean2 = water2 & (oc2 >= lk2)
    h2[ocean2] = 0.0
    h2[water2] = np.maximum(h2[water2], 0.0)
    u = pack_height(h2, "earth/height_2k.png")
    hq = u.astype(np.float64) * H_STEP - H_OFFSET
    STATS["earth_height2k_min_m"], STATS["earth_height2k_max_m"] = float(hq.min()), float(hq.max())
    STATS["earth_topo4k_land_frac"] = float((~water4).mean())
    STATS["earth_h4k_max_m"] = float(h4.max())


# ============================================================================= MOON
def build_moon() -> None:
    import tifffile
    log("moon: LROC color (2019 lroc_color_poles_8k) -> 4k Lanczos")
    col = tifffile.imread(raw("moon/lroc_color_poles_8k.tif"))
    assert col.shape == (4096, 8192, 3) and col.dtype == np.uint8, col.shape
    c4 = resize_u8(col, (4096, 2048), Image.LANCZOS)
    STATS["moon_color_mean"] = [round(float(x), 1) for x in c4.reshape(-1, 3).mean(0)]
    save_jpeg(c4, "moon/color_4k.jpg", 90)

    log("moon: LOLA ldem_16 (km rel. 1737.4 km) -> height 2k + ENU normals 4k (E=2)")
    km = tifffile.imread(raw("moon/ldem_16.tif"))
    assert km.shape == (2880, 5760) and km.dtype == np.float32, km.shape
    m = km.astype(np.float32) * 1000.0
    STATS["moon_src_min_m"], STATS["moon_src_max_m"] = float(m.min()), float(m.max())
    u = pack_height(resize_f32(m, (2048, 1024)), "moon/height_2k.png")
    hq = u.astype(np.float64) * H_STEP - H_OFFSET
    STATS["moon_height2k_min_m"], STATS["moon_height2k_max_m"] = float(hq.min()), float(hq.max())
    save_jpeg(enu_normal_rgb(resize_f32(m, (4096, 2048)), R_MOON, 2.0), "moon/normal_4k.jpg", 92, subsampling=0)


# ============================================================================= MARS
def _isis_num(txt: str, key: str) -> float:
    return float(re.search(rf"^\s*{key}\s*=\s*([-+0-9.eE]+)", txt, re.M).group(1))


def build_mars() -> None:
    import tifffile
    log("mars: Viking colorized global mosaic 925 m -> 4k (geo-referenced Lanczos)")
    lbl = raw("mars/Mars_Viking_ClrMosaic_global_925m.lbl").read_text()
    ulx, uly = _isis_num(lbl, "UpperLeftCornerX"), _isis_num(lbl, "UpperLeftCornerY")
    res, req = _isis_num(lbl, "PixelResolution"), _isis_num(lbl, "EquatorialRadius")
    assert "LongitudeDirection = PositiveEast" in lbl and "CenterLongitude    = 0.0" in lbl
    m_per_deg = 2.0 * math.pi * req / 360.0
    ppd = m_per_deg / res
    lon0, lat0 = ulx / m_per_deg, uly / m_per_deg          # outer edge of pixel (0,0)
    # The mosaic spans -180.008..+179.993 deg (not exactly 360), so sample the exact -180..180 box
    # after padding PAD wrapped columns on both sides (longitude is periodic).
    PAD = 8
    box = ((-180.0 - lon0) * ppd + PAD, (lat0 - 90.0) * ppd, (180.0 - lon0) * ppd + PAD, (lat0 + 90.0) * ppd)
    STATS["mars_color_src_box_px"] = [round(b, 3) for b in box]
    a = tifffile.imread(raw("mars/Mars_Viking_ClrMosaic_global_925m.tif"))
    if a.shape[0] == 3:
        a = np.moveaxis(a, 0, -1)
    assert a.shape == (11530, 23059, 3) and a.dtype == np.uint8, a.shape
    assert 0 <= box[1] and box[3] <= a.shape[0], box
    # NoData (0,0,0) occurs only as the single column 0 (the ~1 px antimeridian seam of the mosaic):
    # fill it from its two longitude neighbours (wrap-around) before resampling.
    nodata = ~a.any(axis=2)
    bad_cols = np.nonzero(nodata.all(axis=0))[0]
    STATS["mars_color_nodata_px"] = int(nodata.sum())
    STATS["mars_color_nodata_cols_filled"] = bad_cols.tolist()
    assert nodata.sum() == len(bad_cols) * a.shape[0] and np.all(np.diff(bad_cols) > 1), "unexpected NoData layout"
    a = np.ascontiguousarray(a)
    for c in bad_cols:
        a[:, c] = ((a[:, c - 1].astype(np.uint16) + a[:, (c + 1) % a.shape[1]]) // 2).astype(np.uint8)

    def wrap(x: np.ndarray) -> np.ndarray:
        return np.concatenate([x[:, -PAD:], x, x[:, :PAD]], axis=1)

    bands = [resize_u8(wrap(a[..., b]), (4096, 2048), Image.LANCZOS, box=box) for b in range(3)]
    del a
    save_jpeg(np.stack(bands, axis=-1), "mars/color_4k.jpg", 90)

    log("mars: MOLA MEGDR 16 px/deg (int16 BE, m rel. areoid) -> height 2k + ENU normals 4k (E=3)")
    lbl = raw("mars/megt90n000eb.lbl").read_text()
    assert "MSB_INTEGER" in lbl and "LINE_SAMPLES                 = 5760" in lbl and "WESTERNMOST_LONGITUDE        = 0.0" in lbl
    mo = np.fromfile(raw("mars/megt90n000eb.img"), dtype=">i2").reshape(2880, 5760).astype(np.float32)
    mo = np.roll(mo, -2880, axis=1)   # source column 0 = 0..1/16 deg E  ->  column 0 = 180 deg W
    STATS["mars_src_min_m"], STATS["mars_src_max_m"] = float(mo.min()), float(mo.max())
    u = pack_height(resize_f32(mo, (2048, 1024)), "mars/height_2k.png")
    hq = u.astype(np.float64) * H_STEP - H_OFFSET
    STATS["mars_height2k_min_m"], STATS["mars_height2k_max_m"] = float(hq.min()), float(hq.max())
    save_jpeg(enu_normal_rgb(resize_f32(mo, (4096, 2048)), R_MARS, 3.0), "mars/normal_4k.jpg", 92, subsampling=0)


# ============================================================================= SKY
STAR_MAG_LIMIT = 7.0


def build_stars() -> None:
    log(f"sky/stars: HYG v4.1, vmag <= {STAR_MAG_LIMIT}, Sun excluded")
    recs = []
    with open(raw("sky/hygdata_v41.csv"), newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["id"] == "0" or r["proper"] == "Sol":
                continue
            try:
                mag = float(r["mag"])
            except ValueError:
                continue
            if mag > STAR_MAG_LIMIT:
                continue
            ci = r["ci"].strip()
            recs.append((mag, int(r["id"]), float(r["ra"]) * 15.0, float(r["dec"]), float(ci) if ci else 0.65,
                         r["proper"], r["hip"], ci == ""))
    recs.sort(key=lambda t: (t[0], t[1]))
    mag = np.array([t[0] for t in recs])
    ra = np.deg2rad([t[2] for t in recs])
    dec = np.deg2rad([t[3] for t in recs])
    bv = np.array([t[4] for t in recs])
    data = np.stack([np.cos(dec) * np.cos(ra), np.sin(dec), -np.cos(dec) * np.sin(ra), mag, bv], axis=1)
    blob = data.astype("<f4").tobytes()
    meta = {
        "count": len(recs),
        "magLimit": STAR_MAG_LIMIT,
        "source": "HYG Database v4.1 (hygdata_v41.csv), https://github.com/astronexus/HYG-Database",
        "license": "CC BY-SA 4.0 (derived from HYG; keep attribution + share-alike)",
        "format": "data = base64 of a little-endian Float32Array, 5 floats per star: x, y, z, vmag, bv",
        "frame": "unit vector from J2000 RA a / Dec d: x = cos(d)cos(a), y = sin(d), z = -cos(d)sin(a)",
        "sortedBy": "vmag ascending",
        "missingBV": 0.65,
        "missingBVCount": int(sum(1 for t in recs if t[7])),
        "excluded": "the Sun (HYG id 0)",
        "brightest": [{"name": t[5] or f"HIP {t[6]}", "vmag": t[0]} for t in recs[:5]],
    }
    p = write_packed("sky/stars.json", blob, meta)
    STATS["star_count"] = len(recs)
    STATS["star_missing_bv"] = meta["missingBVCount"]
    log(f"wrote sky/stars.json ({len(recs)} stars, {len(blob):,} B packed into {p.stat().st_size:,} B)")


MW_BLACK_PCT = 40.0     # luminance percentile mapped to black (faint high-latitude glow -> near black)
MW_WHITE_PCT = 99.9     # luminance percentile mapped to 1.0 (-> 255)
MW_GAMMA = 1.2          # mild power in linear space; combined with the sRGB OETF the net curve is a
                        # gentle ~0.5 gamma that keeps dust lanes and the faint band edges visible


def _srgb_encode(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1.0 / 2.4) - 0.055)


def build_milkyway() -> None:
    import OpenEXR
    log("sky/milkyway: SVS Deep Star Maps 2020 milkyway_2020_4k.exr -> equatorial, RA 0 at left")
    with OpenEXR.File(str(raw("sky/milkyway_2020_4k.exr"))) as f:
        src = np.asarray(f.channels()["RGB"].pixels, dtype=np.float32)
    Hs, Ws = src.shape[:2]
    assert (Ws, Hs) == (4096, 2048), src.shape
    W, H = 4096, 2048
    ra = (np.arange(W) + 0.5) / W * 360.0
    dec = 90.0 - (np.arange(H) + 0.5) / H * 180.0
    # Source: plate carree, RA 0h at the image centre, RA increasing to the LEFT, Dec +90 at top.
    xs = np.mod(0.5 - ra / 360.0, 1.0) * Ws - 0.5
    ys = (90.0 - dec) / 180.0 * Hs - 0.5
    x0 = np.floor(xs).astype(np.int64)
    fx = (xs - x0).astype(np.float32)[None, :, None]
    x1 = (x0 + 1) % Ws
    x0 %= Ws
    y0 = np.floor(ys).astype(np.int64)
    fy = (ys - y0).astype(np.float32)[:, None, None]
    y1 = np.clip(y0 + 1, 0, Hs - 1)
    y0 = np.clip(y0, 0, Hs - 1)
    top = src[y0][:, x0] * (1 - fx) + src[y0][:, x1] * fx
    bot = src[y1][:, x0] * (1 - fx) + src[y1][:, x1] * fx
    lin = top * (1 - fy) + bot * fy
    lum = luminance(lin)
    black = float(np.percentile(lum, MW_BLACK_PCT))
    white = float(np.percentile(lum, MW_WHITE_PCT))
    y = np.clip((lin - black) / (white - black), 0.0, None)
    y = np.power(y, MW_GAMMA)
    img = np.clip(np.rint(_srgb_encode(y) * 255.0), 0, 255).astype(np.uint8)
    STATS["milkyway_linear_black_white"] = [black, white]
    save_jpeg(img, "sky/milkyway_4k.jpg", 90)


# ============================================================================= PBR / GENERATED
def _png_u8(path: Path) -> np.ndarray:
    import imagecodecs
    a = imagecodecs.png_decode(path.read_bytes())
    if a.dtype == np.uint16:
        a = ((a.astype(np.uint32) * 255 + 32767) // 65535).astype(np.uint8)
    assert a.dtype == np.uint8
    return a


def seam_ratio(a: np.ndarray) -> tuple[float, float]:
    """Tileability metric per axis: mean |difference| across the wrap-around seam divided by the
    LARGEST mean |difference| between any two adjacent interior columns (rows). <= ~1 means the
    seam is no worse than the image's own interior (tile joints in a paver texture legitimately
    produce large interior differences, so the max - not the mean - is the fair reference)."""
    f = a.astype(np.float32)
    if f.ndim == 2:
        f = f[..., None]
    cx = np.abs(np.diff(f, axis=1)).mean(axis=(0, 2))
    cy = np.abs(np.diff(f, axis=0)).mean(axis=(1, 2))
    return float(np.abs(f[:, 0] - f[:, -1]).mean() / cx.max()), float(np.abs(f[0] - f[-1]).mean() / cy.max())


def build_pbr() -> None:
    STATS["pbr"] = {}
    for name, (pid, _) in PBR_SETS.items():
        log(f"pbr/{name}: Poly Haven {pid} 1k")
        for suffix, phmap in PBR_MAPS.items():
            a = _png_u8(raw(f"pbr/{pid}_{phmap}_1k.png"))
            if a.ndim == 3 and a.shape[2] in (2, 4):
                # some Poly Haven PNGs carry a vestigial alpha of 0.997..1.0 - effectively opaque
                assert a[..., -1].min() >= 250, f"{pid} {phmap} has real transparency"
                a = a[..., :-1]
            if suffix == "rough":
                a = a if a.ndim == 2 else a[..., 0]
            elif a.ndim == 2:
                a = np.repeat(a[..., None], 3, axis=2)
            assert a.shape[:2] == (1024, 1024), a.shape
            if suffix == "nor":
                save_jpeg(a, f"pbr/{name}_nor.jpg", 90, subsampling=0)
            else:
                save_jpeg(a, f"pbr/{name}_{suffix}.jpg", 90)
            STATS["pbr"][f"{name}_{suffix}"] = [round(s, 2) for s in seam_ratio(a)]


WATER_N = 512            # texture size (px)
WATER_PEAK_PX = 128.0    # spectral peak wavelength = 1/4 of the tile -> ~4 dominant crests per tile
WATER_CUT_PX = 12.0      # Gaussian roll-off of wavelets shorter than ~12 px (keeps the map smooth)
WATER_SPREAD_POW = 4     # directional spreading |cos(theta)|^4 around the wind ...
WATER_ISO = 0.03         # ... plus a small isotropic floor (cross-wind chop)
WATER_WIND_DEG = 25.0    # wind direction, degrees counter-clockwise from +x (image right), y = image up
WATER_RMS_SLOPE = 0.20   # Cox & Munk: mean-square slope ~0.04 for a ~7 m/s wind -> rms slope ~0.2
WATER_SEED = 20260924


def build_water_normal() -> None:
    log("water/normal: FFT of a JONSWAP-shaped k^-4 (Phillips) spectrum, seeded -> periodic height -> OpenGL normals")
    N = WATER_N
    rng = np.random.default_rng(WATER_SEED)
    k1 = 2.0 * math.pi * np.fft.fftfreq(N)          # radians per pixel
    kx, ky = k1[None, :], k1[:, None]               # x = columns (right), ky along rows (down)
    k = np.sqrt(kx * kx + ky * ky)
    k[0, 0] = 1e-9
    kp, kc = 2.0 * math.pi / WATER_PEAK_PX, 2.0 * math.pi / WATER_CUT_PX
    # Phillips k^-4 saturation range, Pierson-Moskowitz low-k roll-off, JONSWAP peak enhancement (gamma 3.3)
    S = k ** -4 * np.exp(-1.25 * (kp / k) ** 4)
    sigma = np.where(k <= kp, 0.07, 0.09)
    S *= 3.3 ** np.exp(-((k - kp) ** 2) / (2.0 * (sigma * kp) ** 2))
    wd = math.radians(WATER_WIND_DEG)
    cos_t = (kx * math.cos(wd) - ky * math.sin(wd)) / k   # -ky: rows run down, wind angle is measured with y up
    S *= (np.abs(cos_t) ** WATER_SPREAD_POW + WATER_ISO) * np.exp(-(k / kc) ** 2)
    S[0, 0] = 0.0
    Hk = (rng.standard_normal((N, N)) + 1j * rng.standard_normal((N, N))) * np.sqrt(S / 2.0)
    sx = np.real(np.fft.ifft2(1j * kx * Hk))        # dh/dx     (spectral derivative -> exactly periodic)
    sy = np.real(np.fft.ifft2(1j * ky * Hk))        # dh/d(row) (rows go DOWN)
    s = WATER_RMS_SLOPE / math.sqrt(float((sx * sx + sy * sy).mean()))
    sx, sy = sx * s, sy * s
    # OpenGL convention: +Y (green) points UP the image, so dh/dy_up = -dh/d(row)
    nx, ny = -sx, sy
    inv = 1.0 / np.sqrt(nx * nx + ny * ny + 1.0)
    rgb = np.clip(np.rint((np.stack([nx * inv, ny * inv, inv], -1) * 0.5 + 0.5) * 255), 0, 255).astype(np.uint8)
    save_png(rgb, "water/normal.png")
    STATS["water_seam_ratio"] = [round(v, 2) for v in seam_ratio(rgb)]
    STATS["water_max_slope"] = round(float(np.sqrt(sx * sx + sy * sy).max()), 3)


def build_noise() -> None:
    log("noise/blue_noise: Christoph Peters 128x128 LDR_LLL1_0 (CC0)")
    a = _png_u8(raw("noise/LDR_LLL1_0_128.png"))
    g = a if a.ndim == 2 else a[..., 0]
    if a.ndim == 3:
        assert (a[..., :3] == g[..., None]).all(), "expected L,L,L channels"
    assert g.shape == (128, 128)
    save_png(g, "noise/blue_noise.png")
    STATS["blue_noise_hist_minmax"] = [int(np.bincount(g.ravel(), minlength=256).min()),
                                       int(np.bincount(g.ravel(), minlength=256).max())]


def build_hdri() -> None:
    src = raw(f"hdri/{HDRI_ID}_1k.hdr")
    blob = src.read_bytes()
    head = blob[:4096]
    assert head.startswith(b"#?RADIANCE") or head.startswith(b"#?RGBE"), "not a Radiance HDR"
    m = re.search(rb"\n-Y (\d+) \+X (\d+)\n", head)
    assert m and (int(m.group(1)), int(m.group(2))) == (512, 1024), m
    dst = write_packed("hdri/vab_1k.json", blob, {
        "format": "data = base64 of a Radiance RGBE (.hdr) file, unmodified",
        "source": f"Poly Haven HDRI {HDRI_ID} (1k), https://polyhaven.com/a/{HDRI_ID}",
        "license": "CC0",
        "width": 1024,
        "height": 512,
    })
    log(f"wrote {dst.relative_to(ROOT)} 1024x512 RGBE {len(blob):,} B packed into {dst.stat().st_size:,} B")


def build_fonts() -> None:
    for name, (rawrel, _) in FONTS.items():
        src = raw(rawrel)
        if name.endswith(".woff2"):
            assert src.read_bytes()[:4] == b"wOF2", src
        dst = out(f"fonts/{name}")
        shutil.copyfile(src, dst)
        log(f"wrote {dst.relative_to(ROOT)} {dst.stat().st_size:,} B")


# ============================================================================= CREDITS
CREDITS = """# APOGEE asset credits & licenses

Generated by `tools/assets/build_assets.py` (re-running it regenerates this file). Raw downloads live in
`raw-assets/` (git-ignored); the script header lists every download URL.

Planet maps: equirectangular, width = 2 x height, column 0 = 180 deg W, longitude increasing eastward,
row 0 = 90 deg N (Moon: longitude 0 = mean sub-Earth point). Packed heights: `h = (R*256 + G) * 0.5 - 10000`
metres (Earth: EGM2008 geoid, oceans 0; Moon: rel. 1737.4 km sphere; Mars: rel. MOLA areoid).

| Output | Source data | Author / credit | License | URL |
|---|---|---|---|---|
| `earth/day_8k.jpg`, `earth/day_4k.jpg` | Blue Marble Next Generation w/ Topography & Bathymetry, September 2004 (`world.topo.bathy.200409.3x21600x10800.jpg`), Lanczos-downsampled | NASA Earth Observatory, Reto Stockli (NASA GSFC) | Public domain (NASA) | https://visibleearth.nasa.gov/images/73801 (file: https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73801/world.topo.bathy.200409.3x21600x10800.jpg) |
| `earth/night_4k.jpg` | Earth at Night / Black Marble 2016, grayscale 3 km (`BlackMarble_2016_3km_gray.jpg`) | NASA Earth Observatory (Joshua Stevens), Suomi NPP VIIRS data (Miguel Roman, NASA GSFC) | Public domain (NASA) | https://visibleearth.nasa.gov/images/144897 (file: https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144897/BlackMarble_2016_3km_gray.jpg) |
| `earth/clouds_8k.jpg`, `earth/clouds_4k.jpg` | Blue Marble clouds composite (`cloud_combined_8192.tif`) | NASA Goddard Space Flight Center (Reto Stockli), MODIS data | Public domain (NASA) | https://visibleearth.nasa.gov/images/57747 (file: https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_8192.tif) |
| `earth/topo_4k.png`, `earth/normal_4k.jpg`, `earth/height_2k.png` | ETOPO 2022 60 arc-second surface elevation (ice surface, EGM2008 heights) | NOAA National Centers for Environmental Information, doi:10.25921/fd45-gt74 | Public domain (U.S. Government work) | https://www.ncei.noaa.gov/products/etopo-global-relief-model |
| (land/water mask for the three files above) | Natural Earth 1:10m land + Antarctic ice shelves (= land); water = ocean + NE 1:10m lakes >= 1000 km2 (all "Lake"/"Reservoir"; "Alkaline Lake" only if dark in the Sep 2004 Blue Marble, i.e. not a dry salt pan) | Natural Earth (naturalearthdata.com) | Public domain | https://github.com/nvkelso/natural-earth-vector |
| `moon/color_4k.jpg` | CGI Moon Kit, 2019 color map `lroc_color_poles_8k.tif` (LROC WAC Hapke-normalized mosaic + LOLA LDAM poles) | NASA Scientific Visualization Studio (Ernie Wright); LRO LROC team (NASA/GSFC/Arizona State University) | Public domain (NASA) | https://svs.gsfc.nasa.gov/4720 |
| `moon/height_2k.png`, `moon/normal_4k.jpg` | CGI Moon Kit `ldem_16.tif` (LRO LOLA gridded DEM, 16 px/deg, km rel. 1737.4 km sphere) | NASA SVS (Ernie Wright); LRO LOLA science team | Public domain (NASA) | https://svs.gsfc.nasa.gov/4720 |
| `mars/color_4k.jpg` | Mars Viking Colorized Global Mosaic 925 m (`Mars_Viking_ClrMosaic_global_925m.tif`) | USGS Astrogeology Science Center; NASA Viking Orbiter imagery | Public domain (USGS/NASA) | https://planetarymaps.usgs.gov/mosaic/Mars_Viking_ClrMosaic_global_925m.tif |
| `mars/height_2k.png`, `mars/normal_4k.jpg` | MGS MOLA Mission Experiment Gridded Data Record, 16 px/deg topography (`MEGT90N000EB.IMG`, m rel. areoid) | NASA PDS Geosciences Node; MGS MOLA Science Team (D. E. Smith, M. T. Zuber et al.) | Public domain (NASA) | https://pds-geosciences.wustl.edu/missions/mgs/megdr.html |
| `sky/stars.json` | HYG Database v4.1 (`hygdata_v41.csv`), stars with V <= 7.0, Sun excluded | David Nash / astronexus (compiled from Hipparcos, Yale BSC, Gliese) | **CC BY-SA 4.0** - the derived sky/stars.json is shared under CC BY-SA 4.0 too | https://github.com/astronexus/HYG-Database |
| `sky/milkyway_4k.jpg` | Deep Star Maps 2020, Milky Way background without Hipparcos/Tycho stars (`milkyway_2020_4k.exr`), re-projected + tone-mapped | NASA Scientific Visualization Studio (Ernie Wright); star data Hipparcos-2, Tycho-2, Gaia DR2 (ESA/Gaia/DPAC), UCAC3 | Public domain (NASA SVS) | https://svs.gsfc.nasa.gov/4851 |
{pbr_rows}| `water/normal.png` | Generated by `build_assets.py` (JONSWAP-shaped k^-4 Phillips spectrum, random phases, FFT, seed {seed}) | APOGEE project | CC0 | - |
| `noise/blue_noise.png` | Free blue noise textures, 128x128 `LDR_LLL1_0.png` | Christoph Peters (Moments in Graphics) | CC0 1.0 | http://momentsingraphics.de/BlueNoise.html (mirror: https://github.com/Calinou/free-blue-noise-textures) |
| `hdri/vab_1k.json` | Poly Haven HDRI "Empty Warehouse 01" (`{hdri}_1k.hdr`, unmodified, base64-packed) | Sergej Majboroda | CC0 | https://polyhaven.com/a/{hdri} |
| `fonts/rajdhani-{{500,600,700}}.woff2` | Rajdhani (Google Fonts latin subset) | Indian Type Foundry | SIL OFL 1.1 (`fonts/OFL-Rajdhani.txt`) | https://fonts.google.com/specimen/Rajdhani |
| `fonts/inter-var.woff2` | Inter variable (wght axis; latin subset) | The Inter Project Authors (Rasmus Andersson) | SIL OFL 1.1 (`fonts/OFL-Inter.txt`) | https://fonts.google.com/specimen/Inter |
| `fonts/jetbrains-mono-var.woff2` | JetBrains Mono variable (wght axis; latin subset) | The JetBrains Mono Project Authors | SIL OFL 1.1 (`fonts/OFL-JetBrainsMono.txt`) | https://fonts.google.com/specimen/JetBrains+Mono |

Notes
- NASA/NOAA/USGS material is not copyrighted in the U.S.; credit lines above are courtesy attributions
  requested by the providers. Natural Earth, Poly Haven and the blue-noise textures are public domain / CC0.
- The only share-alike item is the star catalogue (HYG, CC BY-SA 4.0). Keep this file (or an equivalent
  in-game credit) with the game to satisfy attribution.
- The game bundle includes three.js (MIT License, (c) three.js authors) - full text in `licenses/three.js-MIT.txt`.
- Binary data ships base64-packed in JSON (`"data"` field) so any static host can serve it.
- Not used by the game (moved to `raw-assets/unused/` after a build): `earth/topo_4k.png`, `noise/blue_noise.png`.
"""


def build_credits() -> None:
    rows = ""
    for name, (pid, author) in PBR_SETS.items():
        rows += (f"| `pbr/{name}_diff.jpg`, `pbr/{name}_nor.jpg`, `pbr/{name}_rough.jpg` | Poly Haven texture "
                 f"`{pid}` (1k diffuse, OpenGL normal, roughness) | {author} | CC0 | https://polyhaven.com/a/{pid} |\n")
    text = CREDITS.replace("{pbr_rows}", rows).replace("{seed}", str(WATER_SEED)).replace("{hdri}", HDRI_ID)
    text = text.replace("{{500,600,700}}", "{500,600,700}")
    out("CREDITS.md").write_text(text)
    log("wrote public/assets/CREDITS.md")


# ============================================================================= VERIFY
CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str) -> None:
    CHECKS.append((name, bool(ok), detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: {detail}", flush=True)


def _img(rel: str) -> np.ndarray:
    return np.asarray(Image.open(OUT / rel))


def _flips(a: np.ndarray) -> dict[str, np.ndarray]:
    return {"as-is": a, "mirrored E-W": a[:, ::-1], "flipped N-S": a[::-1], "rolled 180deg": np.roll(a, a.shape[1] // 2, 1)}


def verify_earth() -> None:
    print("EARTH")
    day = _img("earth/day_4k.jpg")
    topo = _img("earth/topo_4k.png")
    W, H = 4096, 2048
    check("day_4k size", day.shape == (H, W, 3), str(day.shape))
    check("day_8k size", _img("earth/day_8k.jpg").shape == (4096, 8192, 3), "8192x4096")
    check("topo_4k is 8-bit gray PNG", topo.shape == (H, W) and topo.dtype == np.uint8, str(topo.shape))
    blue = day[..., 2].astype(np.float32) - day[..., 0].astype(np.float32)
    water = topo == 0
    for label, b in _flips(blue).items():
        sep = float(b[water].mean() - b[~water].mean())
        check(f"day vs NE-mask blueness separation ({label})", (sep > 40) if label == "as-is" else (sep < 20),
              f"mean(B-R) water - land = {sep:.1f}")
    feats = [("Florida (28.0N, 81.5W)", -81.5, 28.0, "land"), ("Gulf of Mexico (25N, 90W)", -90.0, 25.0, "water"),
             ("Atlantic E of Florida (28N, 76W)", -76.0, 28.0, "water"), ("Netherlands polder (52.3N, 5.0E)", 5.0, 52.3, "land"),
             ("Caspian Sea (42N, 50.5E)", 50.5, 42.0, "water"), ("Lake Superior (47.7N, 87.5W)", -87.5, 47.7, "water"),
             ("Lake Victoria (1S, 33E)", 33.0, -1.0, "water"), ("Sahara (23N, 10E)", 10.0, 23.0, "land"),
             ("Ross Ice Shelf (81S, 175W)", -175.0, -81.0, "land"), ("Pacific (0, 150W)", -150.0, 0.0, "water")]
    for name, lon, lat, want in feats:
        c, r = px(lon, lat, W, H)
        v = int(topo[r, c])
        rgb = tuple(int(x) for x in day[r, c])
        check(f"topo {name}", (v >= 1) if want == "land" else (v == 0), f"px(col={c},row={r}) topo={v} day RGB={rgb}")
    c, r = px(-81.5, 28.0, W, H)
    check("Florida left of centre", c < W // 2, f"col {c} < {W // 2}")
    rr, cc = np.unravel_index(np.argmax(topo), topo.shape)
    lat, lon = 90 - (rr + 0.5) * 180 / H, -180 + (cc + 0.5) * 360 / W
    check("topo max in Himalaya/Karakoram", 25 <= lat <= 37 and 70 <= lon <= 95,
          f"max v={int(topo.max())} at px(col={cc},row={rr}) = ({lat:.2f}N, {lon:.2f}E)")
    c, r = px(86.925, 27.988, W, H)
    win = topo[r - 2:r + 3, c - 2:c + 3]
    check("topo near Everest high", int(win.max()) >= 200, f"max v within 2 px of px(col={c},row={r}) = {int(win.max())}")
    c, r = px(0.0, -80.0, W, H)
    check("topo Antarctic plateau (80S, 0E) high", topo[r, c] >= 120, f"v={int(topo[r, c])}")

    hgt = unpack_height_png(OUT / "earth/height_2k.png")
    check("height_2k size", hgt.shape == (1024, 2048), str(hgt.shape))
    c, r = px(-150.0, 0.0, 2048, 1024)
    check("height_2k ocean = 0 m", hgt[r, c] == 0.0, f"Pacific px(col={c},row={r}) = {hgt[r, c]} m")
    rr, cc = np.unravel_index(np.argmax(hgt), hgt.shape)
    check("height_2k max in Himalaya", 25 <= 90 - (rr + .5) * 180 / 1024 <= 37 and 70 <= -180 + (cc + .5) * 360 / 2048 <= 95,
          f"{hgt.max():.0f} m at px(col={cc},row={rr})")
    for name, lon, lat, lo, hi in (("Lake Superior level", -87.5, 47.7, 150, 230), ("Lake Victoria level", 33.0, -1.0, 1080, 1180),
                                   ("Lake Baikal level", 108.0, 53.5, 400, 520), ("Tibet (32N, 88E)", 88.0, 32.0, 4300, 5600)):
        c, r = px(lon, lat, 2048, 1024)
        check(f"height_2k {name}", lo <= hgt[r, c] <= hi, f"px(col={c},row={r}) = {hgt[r, c]:.1f} m (expect {lo}..{hi})")

    nrm = _img("earth/normal_4k.jpg").astype(np.int32)
    c, r = px(-150.0, 0.0, W, H)
    check("normal ocean flat", np.abs(nrm[r, c] - (128, 128, 255)).max() <= 3, f"Pacific RGB={tuple(nrm[r, c])}")
    # sign sanity: Himalayan front (terrain rises to the north) -> normal leans south (G < 128);
    # Andes west flank (terrain rises to the east) -> normal leans west (R < 128)
    g = ang_mean(nrm[..., 1].astype(np.float32), 84.0, 28.3, 1.0)
    check("normal Himalayan south flank leans south", g < 124, f"mean G around (28.3N, 84E) = {g:.1f}")
    rch = ang_mean(nrm[..., 0].astype(np.float32), -69.8, -18.3, 0.4)
    check("normal Andes west flank (18.3S, 69.8W) leans west", rch < 115, f"mean R = {rch:.1f}")
    rch = ang_mean(nrm[..., 0].astype(np.float32), -118.1, 36.8, 0.3)
    check("normal Sierra Nevada east escarpment (36.8N, 118.1W) leans east", rch > 135, f"mean R = {rch:.1f}")

    night = _img("earth/night_4k.jpg").astype(np.float32)
    check("night_4k size", night.shape == (H, W), str(night.shape))
    for label, a in _flips(night).items():
        ratio = float(a[~water].mean() / max(a[water].mean(), 1e-3))
        check(f"night lights on land ({label})", ratio > 8 if label == "as-is" else ratio < 4, f"mean land/water = {ratio:.1f}")
    for name, lon, lat in (("Cairo", 31.24, 30.04), ("Tokyo", 139.69, 35.68), ("New York", -74.0, 40.71), ("Moscow", 37.62, 55.75)):
        c, r = px(lon, lat, W, H)
        v = float(night[max(r - 1, 0):r + 2, c - 1:c + 2].max())
        check(f"night {name} bright", v >= 120, f"max 3x3 at px(col={c},row={r}) = {v:.0f}")
    c, r = px(10.0, 23.0, W, H)
    check("night Sahara dark", night[r, c] < 20, f"px(col={c},row={r}) = {night[r, c]:.0f}")

    cl = _img("earth/clouds_4k.jpg").astype(np.float32)
    cl8 = _img("earth/clouds_8k.jpg").astype(np.float32)
    check("clouds_4k size", cl.shape == (H, W) and cl8.shape == (4096, 8192), str(cl.shape))
    d = float(np.abs(cl8.reshape(H, 2, W, 2).mean(axis=(1, 3)) - cl).mean())
    check("clouds_8k consistent with clouds_4k", d < 6, f"mean |2x2(8k) - 4k| = {d:.2f}")
    d = float(np.abs(_img("earth/day_8k.jpg").astype(np.float32).reshape(H, 2, W, 2, 3).mean(axis=(1, 3)) - day).mean())
    check("day_8k consistent with day_4k", d < 6, f"mean |2x2(8k) - 4k| = {d:.2f}")
    # persistent clear skies over subtropical deserts (Sahara, Arabia, central Australia, Atacama)
    deserts = [(-15, 35, 15, 30), (38, 55, 17, 28), (120, 140, -30, -20), (-72, -68, -26, -18)]

    def box_mean(a, lon0, lon1, lat0, lat1):
        c0, r1 = px(lon0, lat0, W, H)
        c1, r0 = px(lon1, lat1, W, H)
        return float(a[r0:r1 + 1, c0:c1 + 1].mean())
    for label, a in _flips(cl).items():
        ratio = np.mean([box_mean(a, *b) for b in deserts]) / float(a.mean())
        check(f"clouds: deserts clear ({label})", ratio < 0.35 if label == "as-is" else ratio > 0.4,
              f"mean cloud over 4 desert boxes / global mean = {ratio:.2f}")
    sahara = cl[px(0, 28, W, H)[1]:px(0, 18, W, H)[1], px(-5, 0, W, H)[0]:px(30, 0, W, H)[0]].mean()
    south = cl[px(0, -50, W, H)[1]:px(0, -65, W, H)[1]].mean()
    arctic_fake = cl[px(0, 65, W, H)[1]:px(0, 50, W, H)[1]].mean()
    check("clouds: Sahara clear vs Southern Ocean overcast", sahara < 0.5 * south,
          f"Sahara box (18-28N, 5W-30E) mean {sahara:.1f} vs 50-65S band {south:.1f}")
    sahara_flip = cl[::-1][px(0, 28, W, H)[1]:px(0, 18, W, H)[1], px(-5, 0, W, H)[0]:px(30, 0, W, H)[0]].mean()
    check("clouds: N-S flip would put a cloudy band over the Sahara", sahara_flip > 1.5 * sahara,
          f"flipped Sahara box mean {sahara_flip:.1f}; 50-65N band {arctic_fake:.1f}")


def verify_moon() -> None:
    print("MOON")
    col = _img("moon/color_4k.jpg")
    lum = luminance(col)
    hgt = unpack_height_png(OUT / "moon/height_2k.png")
    check("sizes", col.shape == (2048, 4096, 3) and hgt.shape == (1024, 2048) and _img("moon/normal_4k.jpg").shape == (2048, 4096, 3),
          f"color {col.shape}, height {hgt.shape}")
    c, r = px(59.1, 17.0, 4096, 2048)
    check("Mare Crisium right of centre", c > 2048, f"(17.0N, 59.1E) -> px(col={c},row={r})")
    a_in, a_out = ang_mean(lum, 59.1, 17.0, 4.0), ang_mean(lum, 59.1, 17.0, 16.0, 11.0)
    check("Crisium dark mare vs highland ring", a_in < 0.8 * a_out, f"luma r<4deg {a_in:.1f} vs 11-16deg {a_out:.1f}")
    h_in, h_out = ang_mean(hgt, 59.1, 17.0, 4.0), ang_mean(hgt, 59.1, 17.0, 16.0, 11.0)
    check("Crisium basin low", h_in < h_out - 1500, f"h r<4deg {h_in:.0f} m vs 11-16deg {h_out:.0f} m")
    c, r = px(-11.2, -43.3, 4096, 2048)
    t_in, t_out = ang_mean(lum, -11.2, -43.3, 1.5), ang_mean(lum, -11.2, -43.3, 5.0, 3.0)
    check("Tycho bright (43.3S, 11.2W)", t_in > 1.1 * t_out, f"px(col={c},row={r}) luma r<1.5deg {t_in:.1f} vs 3-5deg {t_out:.1f}")
    f_in, rim = ang_mean(hgt, -11.2, -43.3, 0.6), ang_mean(hgt, -11.2, -43.3, 1.9, 1.3)
    check("Tycho crater depth", f_in < rim - 2000, f"floor {f_in:.0f} m vs rim ring {rim:.0f} m")
    c, r = px(-92.8, -19.4, 4096, 2048)
    o_in, o_out = ang_mean(hgt, -92.8, -19.4, 3.0), ang_mean(hgt, -92.8, -19.4, 20.0, 16.0)
    check("Mare Orientale basin low (19.4S, 92.8W)", o_in < o_out - 2000, f"px(col={c},row={r}) h r<3deg {o_in:.0f} m vs 16-20deg {o_out:.0f} m")
    for label, a in _flips(hgt).items():
        if label == "as-is":
            continue
        fake = ang_mean(a, 59.1, 17.0, 4.0) - ang_mean(a, 59.1, 17.0, 16.0, 11.0)
        check(f"Crisium signal absent when {label}", fake > -1500, f"in-out = {fake:.0f} m")
    rr, cc = np.unravel_index(np.argmin(hgt), hgt.shape)
    check("Moon lowest point in South Pole-Aitken", -80 <= 90 - (rr + .5) * 180 / 1024 <= -50,
          f"{hgt.min():.0f} m at ({90 - (rr + .5) * 180 / 1024:.1f}, {-180 + (cc + .5) * 360 / 2048:.1f})")
    rr, cc = np.unravel_index(np.argmax(hgt), hgt.shape)
    check("Moon highest point on far-side highlands", -20 <= 90 - (rr + .5) * 180 / 1024 <= 20 and -180 <= -180 + (cc + .5) * 360 / 2048 <= -140,
          f"{hgt.max():.0f} m at ({90 - (rr + .5) * 180 / 1024:.1f}, {-180 + (cc + .5) * 360 / 2048:.1f})")


def verify_mars() -> None:
    print("MARS")
    col = _img("mars/color_4k.jpg")
    lum = luminance(col)
    hgt = unpack_height_png(OUT / "mars/height_2k.png")
    check("sizes", col.shape == (2048, 4096, 3) and hgt.shape == (1024, 2048) and _img("mars/normal_4k.jpg").shape == (2048, 4096, 3),
          f"color {col.shape}, height {hgt.shape}")
    rr, cc = np.unravel_index(np.argmax(hgt), hgt.shape)
    lat, lon = 90 - (rr + .5) * 180 / 1024, -180 + (cc + .5) * 360 / 2048
    check("Mars highest point = Olympus Mons (18.65N, 133.8W)", abs(lat - 18.65) < 3 and abs(lon + 133.8) < 3,
          f"{hgt.max():.0f} m at px(col={cc},row={rr}) = ({lat:.2f}, {lon:.2f})")
    c, r = px(70.0, -42.0, 2048, 1024)
    hel = ang_mean(hgt, 70.0, -42.0, 5.0)
    check("Hellas basin deep (42S, 70E)", hel < -5000, f"px(col={c},row={r}) mean h r<5deg = {hel:.0f} m")
    rr, cc = np.unravel_index(np.argmin(hgt), hgt.shape)
    lat, lon = 90 - (rr + .5) * 180 / 1024, -180 + (cc + .5) * 360 / 2048
    check("Mars lowest point inside Hellas", -50 < lat < -30 and 55 < lon < 85, f"{hgt.min():.0f} m at ({lat:.2f}, {lon:.2f})")
    syr, ara = ang_mean(lum, 69.5, 8.4, 3.0), ang_mean(lum, 5.0, 20.0, 3.0)
    check("color: Syrtis Major dark vs Arabia Terra bright", syr < 0.8 * ara, f"luma {syr:.1f} vs {ara:.1f}")
    om_c, om_r = px(-133.8, 18.65, 4096, 2048)
    check("Olympus Mons left of centre in color map", om_c < 2048, f"px(col={om_c},row={om_r})")


def verify_sky() -> None:
    print("SKY")
    mw = _img("sky/milkyway_4k.jpg")
    lum = luminance(mw)
    check("milkyway size", mw.shape == (2048, 4096, 3), str(mw.shape))

    def sky_px(ra, dec):
        return int(ra / 360 * 4096) % 4096, int((90 - dec) / 180 * 2048)

    gc = ang_mean(lum, 266.4 - 180.0, -28.9, 3.0)   # ang_mean works in lon = RA - 180 for this grid
    anti = ang_mean(lum, 86.4 - 180.0, 28.9, 3.0)
    mirror = ang_mean(lum, (360 - 266.4) - 180.0, -28.9, 3.0)
    check("galactic centre bright (RA 266.4, Dec -28.9)", gc > 1.3 * anti and gc > 1.8 * mirror,
          f"px{sky_px(266.4, -28.9)} mean luma r<3deg {gc:.1f}; anticentre {anti:.1f}; RA-mirrored position {mirror:.1f}")
    small = resize_f32(lum, (360, 180))
    rr, cc = np.unravel_index(np.argmax(small), small.shape)
    check("brightest 1-deg cell near galactic centre", abs((cc + 0.5) - 266.4) < 15 and abs((90 - rr - 0.5) + 28.9) < 12,
          f"RA {cc + 0.5:.1f}, Dec {90 - rr - 0.5:.1f}")
    for name, ra, dec in (("LMC", 80.9, -69.8), ("SMC", 13.2, -72.8)):
        a_in, a_out = ang_mean(lum, ra - 180.0, dec, 2.0), ang_mean(lum, ra - 180.0, dec, 9.0, 6.0)
        check(f"{name} blob (RA {ra}, Dec {dec})", a_in > 1.3 * a_out, f"px{sky_px(ra, dec)} luma r<2deg {a_in:.1f} vs 6-9deg {a_out:.1f}")
    meta, blob = read_packed("sky/stars.json")
    stars = np.frombuffer(blob, dtype="<f4").reshape(-1, 5)
    check("stars count/meta", len(stars) == meta["count"], f"{len(stars)} stars, first vmag {stars[0, 3]:.2f}")
    check("stars sorted by vmag", bool(np.all(np.diff(stars[:, 3]) >= 0)) and stars[:, 3].max() <= 7.0, f"max vmag {stars[:, 3].max():.2f}")
    a, d = math.radians(101.2872), math.radians(-16.7161)
    want = np.array([math.cos(d) * math.cos(a), math.sin(d), -math.cos(d) * math.sin(a)])
    check("brightest star = Sirius direction", float(np.dot(stars[0, :3], want)) > 0.99999,
          f"xyz={np.round(stars[0, :3], 4).tolist()} vs expected {np.round(want, 4).tolist()}, bv={stars[0, 4]:.3f}")
    pol = stars[np.argmax(stars[:, 1])]
    check("most northern star is Polaris-like", pol[1] > 0.9999 and 1.9 < pol[3] < 2.1, f"y={pol[1]:.5f} vmag={pol[3]:.2f}")
    check("unit vectors", bool(np.allclose(np.linalg.norm(stars[:, :3], axis=1), 1.0, atol=1e-5)), "all |xyz| = 1")


def verify_misc() -> None:
    print("PBR / WATER / NOISE / HDRI / FONTS")
    for name in PBR_SETS:
        for suffix in PBR_MAPS:
            a = _img(f"pbr/{name}_{suffix}.jpg")
            sx, sy = seam_ratio(a)
            check(f"pbr/{name}_{suffix} 1024 & tileable", a.shape[:2] == (1024, 1024) and sx < 1.5 and sy < 1.5,
                  f"{a.shape}, seam/max-interior x={sx:.2f} y={sy:.2f}")
    w = _img("water/normal.png")
    sx, sy = seam_ratio(w)
    check("water normal 512 RGB tileable", w.shape == (512, 512, 3) and sx < 1.2 and sy < 1.2, f"seam/max-interior x={sx:.2f} y={sy:.2f}")
    bn = _img("noise/blue_noise.png")
    check("blue noise 128x128 gray", bn.shape == (128, 128), f"{bn.shape} mean {bn.mean():.1f}")
    for rel in ("earth/topo_4k.png", "earth/height_2k.png", "moon/height_2k.png", "mars/height_2k.png", "water/normal.png", "noise/blue_noise.png"):
        types = sorted(set(t.decode() for t in png_chunk_types(OUT / rel)))
        check(f"{rel} chunks", set(types) <= {"IHDR", "IDAT", "IEND"}, ",".join(types))
    check("hdri/vab_1k.json", read_packed("hdri/vab_1k.json")[1][:2] == b"#?", "Radiance header")
    for name in FONTS:
        if name.endswith(".woff2"):
            check(f"fonts/{name}", (OUT / f"fonts/{name}").read_bytes()[:4] == b"wOF2", "wOF2 magic")


def size_report() -> None:
    print("\nOUTPUT FILES")
    total = 0
    for p in sorted(OUT.rglob("*")):
        if p.is_file():
            n = p.stat().st_size
            total += n
            dims = ""
            if p.suffix in (".jpg", ".png"):
                with Image.open(p) as im:
                    dims = f"{im.size[0]}x{im.size[1]} {im.mode}"
            print(f"  {str(p.relative_to(OUT)):32s} {n:>12,} B  {dims}")
    print(f"  {'TOTAL':32s} {total:>12,} B  ({total / 1e6:.1f} MB)")


# ============================================================================= main
STEPS = {
    "earth_day": build_earth_day,
    "earth_night": build_earth_night,
    "earth_clouds": build_earth_clouds,
    "earth_terrain": build_earth_terrain,
    "moon": build_moon,
    "mars": build_mars,
    "stars": build_stars,
    "milkyway": build_milkyway,
    "pbr": build_pbr,
    "water": build_water_normal,
    "noise": build_noise,
    "hdri": build_hdri,
    "fonts": build_fonts,
    "credits": build_credits,
}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--download", action="store_true", help="download missing raw sources, then exit")
    ap.add_argument("--only", default="", help="comma list of steps: " + ",".join(STEPS))
    ap.add_argument("--verify-only", action="store_true")
    ap.add_argument("--no-verify", action="store_true")
    args = ap.parse_args()
    if args.download:
        download_sources()
        return
    if not args.verify_only:
        steps = [s for s in args.only.split(",") if s] or list(STEPS)
        for s in steps:
            t0 = time.time()
            STEPS[s]()
            log(f"step {s} done in {time.time() - t0:.1f}s")
        rep = RAW / "build_stats.json"
        old = json.loads(rep.read_text()) if rep.exists() else {}
        old.update(STATS)
        rep.write_text(json.dumps(old, indent=1, default=str))
    if not args.no_verify:
        for fn in (verify_earth, verify_moon, verify_mars, verify_sky, verify_misc):
            try:
                fn()
            except FileNotFoundError as e:
                print(f"  [SKIP] {fn.__name__}: {e}")
        size_report()
        fails = [c for c in CHECKS if not c[1]]
        print(f"\n{len(CHECKS) - len(fails)}/{len(CHECKS)} checks passed")
        if fails:
            sys.exit(1)


if __name__ == "__main__":
    main()
