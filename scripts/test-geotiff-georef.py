#!/usr/bin/env python3
"""
Test GeoTIFF Georeferencing - End-to-End

Simulates exactly what our geotiff-writer.js produces:
1. Reads NISAR HDF5 to get actual coordinate boundaries
2. Applies the same pixel-center → pixel-edge correction as main.jsx export handler
3. Applies the same pixelScale calculation as geotiff-writer.js buildCOGFile()
4. Writes a test GeoTIFF using raw TIFF bytes (same logic as our JS writer)
5. Verifies with rasterio that corners and CRS are correct

Usage:
    python3 scripts/test-geotiff-georef.py [path-to-h5-file]
"""

import sys
import os
import struct
import numpy as np
import h5py

try:
    import rasterio
    from rasterio.crs import CRS
    HAS_RASTERIO = True
except ImportError:
    HAS_RASTERIO = False
    print("WARNING: rasterio not available, will write but cannot verify")

H5_PATH = (
    sys.argv[1] if len(sys.argv) > 1
    else 'test_data/NISAR_L2_PR_GCOV_013_155_D_091_2005_DHDH_A_20251226T231525_20251226T231556_P05006_N_F_J_001.h5'
)

# ---- TIFF constants (matching geotiff-writer.js) ----
TAG_IMAGE_WIDTH = 256
TAG_IMAGE_LENGTH = 257
TAG_BITS_PER_SAMPLE = 258
TAG_COMPRESSION = 259
TAG_PHOTOMETRIC = 262
TAG_STRIP_OFFSETS = 273
TAG_SAMPLES_PER_PIXEL = 277
TAG_ROWS_PER_STRIP = 278
TAG_STRIP_BYTE_COUNTS = 279
TAG_PLANAR_CONFIG = 284
TAG_EXTRA_SAMPLES = 338
TAG_SAMPLE_FORMAT = 339
TAG_MODEL_TIEPOINT = 33922
TAG_MODEL_PIXEL_SCALE = 33550
TAG_GEO_KEY_DIRECTORY = 34735

TYPE_SHORT = 3
TYPE_LONG = 4
TYPE_DOUBLE = 12

KEY_GT_MODEL_TYPE = 1024
KEY_GT_RASTER_TYPE = 1025
KEY_PROJECTED_CS_TYPE = 3072
KEY_GEOGRAPHIC_TYPE = 2048
MODEL_TYPE_PROJECTED = 1
MODEL_TYPE_GEOGRAPHIC = 2
RASTER_TYPE_PIXEL_IS_AREA = 1


def write_minimal_geotiff(path, width, height, bounds, epsg, rgba_data):
    """Write a minimal stripped GeoTIFF matching geotiff-writer.js logic."""
    min_x, min_y, max_x, max_y = bounds

    # This matches geotiff-writer.js buildCOGFile() lines 393-394:
    # pixelScaleX = (maxX - minX) / levels[0].width
    # pixelScaleY = (maxY - minY) / levels[0].height
    pixel_scale_x = (max_x - min_x) / width
    pixel_scale_y = (max_y - min_y) / height

    # Build IFD entries as (tag, type, count, value_or_values)
    entries = []
    entries.append((TAG_IMAGE_WIDTH, TYPE_LONG, 1, [width]))
    entries.append((TAG_IMAGE_LENGTH, TYPE_LONG, 1, [height]))
    entries.append((TAG_BITS_PER_SAMPLE, TYPE_SHORT, 4, [8, 8, 8, 8]))
    entries.append((TAG_COMPRESSION, TYPE_SHORT, 1, [1]))  # No compression for test
    entries.append((TAG_PHOTOMETRIC, TYPE_SHORT, 1, [2]))  # RGB
    entries.append((TAG_STRIP_OFFSETS, TYPE_LONG, 1, [0]))  # placeholder
    entries.append((TAG_SAMPLES_PER_PIXEL, TYPE_SHORT, 1, [4]))
    entries.append((TAG_ROWS_PER_STRIP, TYPE_LONG, 1, [height]))
    entries.append((TAG_STRIP_BYTE_COUNTS, TYPE_LONG, 1, [width * height * 4]))
    entries.append((TAG_PLANAR_CONFIG, TYPE_SHORT, 1, [1]))
    entries.append((TAG_EXTRA_SAMPLES, TYPE_SHORT, 1, [1]))  # Associated alpha
    entries.append((TAG_SAMPLE_FORMAT, TYPE_SHORT, 4, [1, 1, 1, 1]))

    # GeoTIFF tags — matches geotiff-writer.js buildIFD()
    # ModelTiepoint: (0, 0, 0) -> (minX, maxY, 0)
    entries.append((TAG_MODEL_TIEPOINT, TYPE_DOUBLE, 6, [0, 0, 0, min_x, max_y, 0]))
    # ModelPixelScale
    entries.append((TAG_MODEL_PIXEL_SCALE, TYPE_DOUBLE, 3, [pixel_scale_x, pixel_scale_y, 0]))

    # GeoKeyDirectory
    is_geographic = 4000 <= epsg < 5000
    model_type = MODEL_TYPE_GEOGRAPHIC if is_geographic else MODEL_TYPE_PROJECTED
    cs_key = KEY_GEOGRAPHIC_TYPE if is_geographic else KEY_PROJECTED_CS_TYPE
    geo_keys = [
        1, 1, 0, 3,
        KEY_GT_MODEL_TYPE, 0, 1, model_type,
        KEY_GT_RASTER_TYPE, 0, 1, RASTER_TYPE_PIXEL_IS_AREA,
        cs_key, 0, 1, epsg,
    ]
    entries.append((TAG_GEO_KEY_DIRECTORY, TYPE_SHORT, len(geo_keys), geo_keys))

    # Sort by tag
    entries.sort(key=lambda e: e[0])

    # Calculate sizes
    type_sizes = {TYPE_SHORT: 2, TYPE_LONG: 4, TYPE_DOUBLE: 8}
    header_size = 8
    num_entries = len(entries)
    ifd_size = 2 + num_entries * 12 + 4

    # Overflow data (values that don't fit in 4 bytes)
    overflow_entries = []
    overflow_size = 0
    for i, (tag, typ, count, values) in enumerate(entries):
        byte_size = type_sizes[typ] * count
        if byte_size > 4:
            overflow_entries.append(i)
            overflow_size += byte_size
            if overflow_size % 2 != 0:
                overflow_size += 1

    ifd_offset = header_size
    overflow_offset = ifd_offset + ifd_size
    strip_offset = overflow_offset + overflow_size
    strip_size = width * height * 4
    total_size = strip_offset + strip_size

    # Fix strip offset
    for i, (tag, typ, count, values) in enumerate(entries):
        if tag == TAG_STRIP_OFFSETS:
            entries[i] = (tag, typ, count, [strip_offset])

    buf = bytearray(total_size)
    view = memoryview(buf)

    # TIFF header
    struct.pack_into('<2sHI', buf, 0, b'II', 42, ifd_offset)

    # IFD
    pos = ifd_offset
    struct.pack_into('<H', buf, pos, num_entries)
    pos += 2

    cur_overflow = overflow_offset
    for i, (tag, typ, count, values) in enumerate(entries):
        byte_size = type_sizes[typ] * count

        struct.pack_into('<HHI', buf, pos, tag, typ, count)
        pos += 8

        if byte_size > 4:
            # Pointer to overflow
            struct.pack_into('<I', buf, pos, cur_overflow)
            # Write overflow data
            opos = cur_overflow
            for v in values:
                if typ == TYPE_SHORT:
                    struct.pack_into('<H', buf, opos, int(v))
                    opos += 2
                elif typ == TYPE_LONG:
                    struct.pack_into('<I', buf, opos, int(v))
                    opos += 4
                elif typ == TYPE_DOUBLE:
                    struct.pack_into('<d', buf, opos, float(v))
                    opos += 8
            cur_overflow += byte_size
            if cur_overflow % 2 != 0:
                cur_overflow += 1
        else:
            # Inline value
            if count == 1:
                if typ == TYPE_SHORT:
                    struct.pack_into('<H', buf, pos, int(values[0]))
                elif typ == TYPE_LONG:
                    struct.pack_into('<I', buf, pos, int(values[0]))
            else:
                vpos = pos
                for v in values:
                    if typ == TYPE_SHORT:
                        struct.pack_into('<H', buf, vpos, int(v))
                        vpos += 2

        pos += 4

    # Next IFD pointer = 0
    struct.pack_into('<I', buf, pos, 0)

    # Write pixel data
    buf[strip_offset:strip_offset + strip_size] = bytes(rgba_data)

    with open(path, 'wb') as f:
        f.write(buf)

    return pixel_scale_x, pixel_scale_y


def main():
    print(f"\n{'='*60}")
    print(f"  GeoTIFF Georeferencing End-to-End Test")
    print(f"{'='*60}")
    print(f"HDF5 file: {os.path.basename(H5_PATH)}\n")

    # ---- Step 1: Read HDF5 ----
    with h5py.File(H5_PATH, 'r') as f:
        band = None
        for b in ['LSAR', 'SSAR']:
            if f'/science/{b}/GCOV/grids/frequencyA' in f:
                band = b
                break
        assert band, "Could not find LSAR or SSAR"

        freq = 'A'
        base = f'/science/{band}/GCOV/grids/frequency{freq}'

        epsg = int(f[f'{base}/projection'][()])
        x_coords = f[f'{base}/xCoordinates'][:]
        y_coords = f[f'{base}/yCoordinates'][:]
        x_spacing = float(f[f'{base}/xCoordinateSpacing'][()])
        y_spacing = float(f[f'{base}/yCoordinateSpacing'][()])

    width_full = len(x_coords)
    height_full = len(y_coords)

    min_x = min(x_coords[0], x_coords[-1])
    max_x = max(x_coords[0], x_coords[-1])
    min_y = min(y_coords[0], y_coords[-1])
    max_y = max(y_coords[0], y_coords[-1])
    raw_bounds = [min_x, min_y, max_x, max_y]

    print(f"EPSG: {epsg}")
    print(f"Dimensions: {width_full} x {height_full}")
    print(f"Native spacing: {abs(x_spacing):.6f} x {abs(y_spacing):.6f}")
    print(f"Raw bounds (pixel-center): [{min_x:.2f}, {min_y:.2f}, {max_x:.2f}, {max_y:.2f}]")

    # ---- Step 2: Apply pixel-center → pixel-edge correction ----
    # This is what main.jsx export handler now does:
    half_px = abs(x_spacing) / 2
    half_py = abs(y_spacing) / 2
    export_bounds = [
        min_x - half_px,
        min_y - half_py,
        max_x + half_px,
        max_y + half_py,
    ]
    print(f"Export bounds (pixel-edge): [{export_bounds[0]:.2f}, {export_bounds[1]:.2f}, {export_bounds[2]:.2f}, {export_bounds[3]:.2f}]")

    # ---- Step 3: Write test GeoTIFF (simulating geotiff-writer.js) ----
    # Use a small test image but with the FULL bounds (same as real export)
    test_w = 64
    test_h = 64
    test_rgba = bytearray(test_w * test_h * 4)
    for i in range(test_w * test_h):
        test_rgba[i * 4] = 255      # R
        test_rgba[i * 4 + 1] = 0    # G
        test_rgba[i * 4 + 2] = 0    # B
        test_rgba[i * 4 + 3] = 255  # A

    out_path = 'test_data/test_georef_jswriter.tif'
    ps_x, ps_y = write_minimal_geotiff(out_path, test_w, test_h, export_bounds, epsg, test_rgba)

    print(f"\nWrote: {out_path}")
    print(f"  Writer pixel scale: {ps_x:.6f} x {ps_y:.6f}")

    # ---- Step 4: Also test with full-res dimensions ----
    # Simulate the pixel scale calculation with actual export dimensions (e.g., 4×4 multilook)
    for ml in [1, 4, 8]:
        ew = width_full // ml if ml > 1 else min(width_full, 4096)
        eh = height_full // ml if ml > 1 else min(height_full, 4096)
        ps_x_ml = (export_bounds[2] - export_bounds[0]) / ew
        ps_y_ml = (export_bounds[3] - export_bounds[1]) / eh
        expected_ps = abs(x_spacing) * ml
        diff = abs(ps_x_ml - expected_ps)
        status = "PASS" if diff < 0.01 else "FAIL"
        print(f"  [{status}] {ml}×{ml} multilook: {ew}x{eh} → pixel scale {ps_x_ml:.6f}m (expected {expected_ps:.1f}m, diff={diff:.6f})")

    # ---- Step 5: Verify with rasterio ----
    if not HAS_RASTERIO:
        print("\nSkipping rasterio verification (not installed)")
        return

    print(f"\n{'='*60}")
    print(f"  VERIFICATION (rasterio)")
    print(f"{'='*60}")

    all_pass = True

    with rasterio.open(out_path) as src:
        b = src.bounds
        t = src.transform
        res = src.res

        print(f"\nFile: {out_path}")
        print(f"  Dimensions: {src.width} x {src.height}, {src.count} bands")
        print(f"  CRS: {src.crs}")
        print(f"  Origin (UL): ({t.c:.2f}, {t.f:.2f})")
        print(f"  Pixel size: ({t.a:.6f}, {t.e:.6f})")
        print(f"  Bounds: [{b.left:.2f}, {b.bottom:.2f}, {b.right:.2f}, {b.top:.2f}]")

        # Check 1: CRS
        actual_epsg = src.crs.to_epsg() if src.crs else None
        ok = actual_epsg == epsg
        status = "PASS" if ok else "FAIL"
        if not ok: all_pass = False
        print(f"\n  [{status}] EPSG code: {actual_epsg} (expected {epsg})")

        # Check 2: Bounds match pixel-edge
        expected_edge = (export_bounds[0], export_bounds[1], export_bounds[2], export_bounds[3])
        actual_bounds = (b.left, b.bottom, b.right, b.top)
        bounds_match = all(abs(a - e) < 1.0 for a, e in zip(actual_bounds, expected_edge))
        status = "PASS" if bounds_match else "FAIL"
        if not bounds_match: all_pass = False
        print(f"  [{status}] Bounds match pixel-EDGE")
        if not bounds_match:
            print(f"    Actual:   [{b.left:.2f}, {b.bottom:.2f}, {b.right:.2f}, {b.top:.2f}]")
            print(f"    Expected: [{expected_edge[0]:.2f}, {expected_edge[1]:.2f}, {expected_edge[2]:.2f}, {expected_edge[3]:.2f}]")

        # Check 3: Bounds do NOT match pixel-center (they shouldn't)
        expected_center = (raw_bounds[0], raw_bounds[1], raw_bounds[2], raw_bounds[3])
        center_match = all(abs(a - e) < 1.0 for a, e in zip(actual_bounds, expected_center))
        status = "PASS" if not center_match else "FAIL"
        if center_match: all_pass = False
        print(f"  [{status}] Bounds differ from pixel-CENTER (should differ by ±{half_px:.0f}m)")

        # Check 4: Origin is at pixel edge upper-left
        origin_ok = abs(t.c - export_bounds[0]) < 0.01 and abs(t.f - export_bounds[3]) < 0.01
        status = "PASS" if origin_ok else "FAIL"
        if not origin_ok: all_pass = False
        print(f"  [{status}] Origin at pixel-edge UL: ({t.c:.2f}, {t.f:.2f})")

        # Check 5: Y pixel scale is negative (north-up)
        y_neg = t.e < 0
        status = "PASS" if y_neg else "FAIL"
        if not y_neg: all_pass = False
        print(f"  [{status}] Y pixel scale is negative (north-up): {t.e:.6f}")

    print(f"\n{'='*60}")
    if all_pass:
        print(f"  ALL TESTS PASSED")
    else:
        print(f"  SOME TESTS FAILED")
    print(f"{'='*60}\n")

    return all_pass


if __name__ == '__main__':
    success = main()
    sys.exit(0 if success else 1)
