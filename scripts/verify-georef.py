#!/usr/bin/env python3
"""
Verify GeoTIFF Georeferencing using rasterio

Reads a GeoTIFF and prints all georeferencing information
so we can compare against the expected values from the HDF5 source.

Usage:
    python3 scripts/verify-georef.py test_data/test_georef.tif
    python3 scripts/verify-georef.py path/to/exported.tif
"""

import sys
import os

try:
    import rasterio
    from rasterio.crs import CRS
except ImportError:
    print("ERROR: rasterio not found. Install with: pip install rasterio")
    sys.exit(1)

try:
    from pyproj import Transformer
    HAS_PYPROJ = True
except ImportError:
    HAS_PYPROJ = False

def verify_geotiff(filepath):
    if not os.path.exists(filepath):
        print(f"ERROR: File not found: {filepath}")
        sys.exit(1)

    with rasterio.open(filepath) as src:
        print(f"\n{'='*60}")
        print(f"  GeoTIFF Verification: {os.path.basename(filepath)}")
        print(f"{'='*60}")

        # --- Dimensions ---
        print(f"\nDimensions: {src.width} x {src.height}, {src.count} bands")
        print(f"Data type: {src.dtypes}")

        # --- Transform ---
        t = src.transform
        print(f"\nTransform (affine):")
        print(f"  | {t.a:.6f}, {t.b:.6f}, {t.c:.6f} |")
        print(f"  | {t.d:.6f}, {t.e:.6f}, {t.f:.6f} |")
        print(f"  Origin (UL):     ({t.c:.2f}, {t.f:.2f})")
        print(f"  Pixel size:      ({t.a:.6f}, {t.e:.6f})")
        print(f"  Resolution:      {src.res}")

        # --- Bounds ---
        b = src.bounds
        print(f"\nBounds:")
        print(f"  left (minX):   {b.left:.2f}")
        print(f"  bottom (minY): {b.bottom:.2f}")
        print(f"  right (maxX):  {b.right:.2f}")
        print(f"  top (maxY):    {b.top:.2f}")

        # --- Corners ---
        ul = (t.c, t.f)
        ur = (t.c + src.width * t.a, t.f + src.width * t.d)
        ll = (t.c + src.height * t.b, t.f + src.height * t.e)
        lr = (t.c + src.width * t.a + src.height * t.b,
              t.f + src.width * t.d + src.height * t.e)

        print(f"\nCorner coordinates (projected):")
        print(f"  Upper-left:  ({ul[0]:.2f}, {ul[1]:.2f})")
        print(f"  Upper-right: ({ur[0]:.2f}, {ur[1]:.2f})")
        print(f"  Lower-left:  ({ll[0]:.2f}, {ll[1]:.2f})")
        print(f"  Lower-right: ({lr[0]:.2f}, {lr[1]:.2f})")

        # --- CRS ---
        print(f"\nCRS:")
        print(f"  {src.crs}")
        if src.crs and src.crs.to_epsg():
            print(f"  EPSG: {src.crs.to_epsg()}")

        # --- Convert to lat/lon ---
        if HAS_PYPROJ and src.crs and src.crs.to_epsg() and src.crs.to_epsg() != 4326:
            epsg = src.crs.to_epsg()
            transformer = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)

            corners = [
                ("Upper-left", ul),
                ("Upper-right", ur),
                ("Lower-left", ll),
                ("Lower-right", lr),
            ]

            print(f"\nCorner coordinates (lat/lon, WGS84):")
            for name, (cx, cy) in corners:
                lon, lat = transformer.transform(cx, cy)
                print(f"  {name}:  ({lon:.6f}, {lat:.6f})  [lon, lat]")

        # --- NISAR expected values for comparison ---
        print(f"\n{'='*60}")
        print(f"  EXPECTED VALUES (NISAR GCOV, EPSG:32718)")
        print(f"{'='*60}")
        print(f"  Pixel-center bounds: [434170.00, 9275770.00, 768230.00, 9601910.00]")
        print(f"  Pixel-edge bounds:   [434160.00, 9275760.00, 768240.00, 9601920.00]")
        print(f"  Native spacing:      20.0 x 20.0 meters")
        print(f"  Dimensions:          16704 x 16308")

        # Check if bounds match expected
        expected_edge = (434160.0, 9275760.0, 768240.0, 9601920.0)
        expected_center = (434170.0, 9275770.0, 768230.0, 9601910.0)

        def check_bounds(actual, expected, label):
            match = all(abs(a - e) < 1.0 for a, e in
                       zip([actual.left, actual.bottom, actual.right, actual.top], expected))
            status = "PASS" if match else "FAIL"
            print(f"\n  [{status}] {label}")
            if not match:
                print(f"    Actual:   [{actual.left:.2f}, {actual.bottom:.2f}, {actual.right:.2f}, {actual.top:.2f}]")
                print(f"    Expected: [{expected[0]:.2f}, {expected[1]:.2f}, {expected[2]:.2f}, {expected[3]:.2f}]")
                diffs = [a - e for a, e in
                        zip([actual.left, actual.bottom, actual.right, actual.top], expected)]
                print(f"    Diffs:    [{', '.join(f'{d:.2f}' for d in diffs)}]")

        check_bounds(b, expected_edge, "Matches pixel-EDGE bounds (PixelIsArea)?")
        check_bounds(b, expected_center, "Matches pixel-CENTER bounds (raw coords)?")

        # Check pixel scale
        res_match = abs(src.res[0] - 20.0) < 0.1 and abs(src.res[1] - 20.0) < 0.1
        status = "PASS" if res_match else "FAIL"
        print(f"\n  [{status}] Pixel scale matches 20.0m?")
        print(f"    Actual: {src.res[0]:.6f} x {src.res[1]:.6f}")

    print(f"\n{'='*60}\n")

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/verify-georef.py <geotiff-file>")
        sys.exit(1)

    verify_geotiff(sys.argv[1])
