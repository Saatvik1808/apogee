"""
LEARNING NOTE: Signed distance fields for crisp coastlines

A binary land/water mask stored at 10 km per pixel produces stair-stepped
shorelines when interpolated. A SIGNED DISTANCE FIELD instead stores, per pixel,
the distance to the nearest coast (positive on land, negative at sea). Distances
vary smoothly, so bilinear interpolation reconstructs the zero-contour (the
coastline) with sub-pixel accuracy — the same trick used for sharp text in games.

We rasterise Natural Earth 1:10m land (+ Antarctic ice shelves) at 21600x10800,
run an exact Euclidean distance transform on both sides (accounting for the
cos(latitude) shrink of longitude spacing), downsample to 4096x2048 and encode
8-bit with a square-root curve (fine precision near the shore):

    v = 128 + 127 * sign(d) * sqrt(min(|d|, 60 km) / 60 km)

Run: raw-assets/.venv/bin/python tools/assets/build_coast_sdf.py
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).parent))
import build_assets as ba  # noqa: E402

W0, H0 = 21600, 10800
W, H = 4096, 2048
D_MAX = 60_000.0
R_EARTH = 6_371_000.0


def main() -> None:
    ba.log("coast_sdf: rasterising Natural Earth land + ice shelves")
    land = ba.rasterize_evenodd((ring for _, poly in ba.geo_polygons(ba.raw("earth/ne_10m_land.geojson")) for ring in poly), W0, H0)
    shelves = ba.rasterize_evenodd((ring for _, poly in ba.geo_polygons(ba.raw("earth/ne_10m_antarctic_ice_shelves_polys.geojson")) for ring in poly), W0, H0)
    land |= shelves
    del shelves
    px_m = (2 * np.pi * R_EARTH) / W0  # metres per pixel along a meridian / at the equator
    lat = 90.0 - (np.arange(H0) + 0.5) * 180.0 / H0
    coslat = np.clip(np.cos(np.radians(lat)), 0.05, 1.0)
    # Process in latitude bands with a local anisotropic sampling so east-west pixel
    # spacing shrinks correctly toward the poles.
    sdf = np.zeros((H0, W0), np.float32)
    band = 400
    pad = 160
    for r0 in range(0, H0, band):
        r1 = min(H0, r0 + band)
        a0 = max(0, r0 - pad)
        a1 = min(H0, r1 + pad)
        sub = land[a0:a1]
        # wrap longitude by padding columns
        sub = np.concatenate([sub[:, -pad:], sub, sub[:, :pad]], axis=1)
        mid = (r0 + r1) // 2
        sx = px_m * float(coslat[mid])
        sy = px_m
        d_land = ndimage.distance_transform_edt(sub, sampling=(sy, sx))  # inside land: dist to water
        d_water = ndimage.distance_transform_edt(~sub, sampling=(sy, sx))  # inside water: dist to land
        s = np.where(sub, d_land, -d_water).astype(np.float32)
        sdf[r0:r1] = s[r0 - a0 : r0 - a0 + (r1 - r0), pad:-pad]
        ba.log(f"coast_sdf: rows {r0}-{r1}")
    del land
    ba.log("coast_sdf: downsampling to 4096x2048")
    img = Image.fromarray(sdf, mode="F").resize((W, H), Image.BOX)
    d = np.asarray(img, dtype=np.float32)
    v = 128.0 + 127.0 * np.sign(d) * np.sqrt(np.minimum(np.abs(d), D_MAX) / D_MAX)
    u8 = np.clip(np.round(v), 0, 255).astype(np.uint8)
    path = ba.save_png(u8, "earth/coast_sdf_4k.png")
    ba.log(f"coast_sdf: wrote {path} ({path.stat().st_size} bytes); land fraction {(d > 0).mean():.3f}")
    # sanity: Cape Canaveral region & open ocean
    for name, lon, lat_ in (("Florida interior", -81.5, 28.0), ("Atlantic", -70.0, 30.0), ("Sahara", 10.0, 23.0)):
        c, r = ba.px(lon, lat_, W, H)
        ba.log(f"  {name}: v={u8[r, c]} d≈{d[r, c]/1000:.1f} km")


if __name__ == "__main__":
    main()
