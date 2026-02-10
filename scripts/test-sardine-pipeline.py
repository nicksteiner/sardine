#!/usr/bin/env python3
"""
Test the full SARdine export pipeline with real NISAR data.

Simulates the EXACT flow:
  main.jsx handleExportGeoTIFF()
    → getExportStripe() from nisar-loader.js
    → writeFloat32GeoTIFF() from geotiff-writer.js

Steps:
  1. Read NISAR HDF5 to get real bounds, CRS, dimensions, pixel spacing
  2. Apply main.jsx bounds correction (pixel-center → pixel-edge)
  3. Compute export dimensions (integer multilook)
  4. Read actual data with box-filter multilook
  5. Write GeoTIFF with our JS-style writer AND rasterio
  6. Load BOTH in rasterio and compare
  7. Verify against HDF5 source truth

Usage:
    python3 scripts/test-sardine-pipeline.py [path-to-h5]
"""

import sys
import os
import struct
import zlib
import numpy as np
import h5py

try:
    import rasterio
    from rasterio.crs import CRS
    from rasterio.transform import from_bounds
except ImportError:
    print("ERROR: rasterio not found")
    sys.exit(1)


# TIFF constants
TAG_IMAGE_WIDTH = 256
TAG_IMAGE_LENGTH = 257
TAG_BITS_PER_SAMPLE = 258
TAG_COMPRESSION = 259
TAG_PHOTOMETRIC = 262
TAG_SAMPLES_PER_PIXEL = 277
TAG_PLANAR_CONFIG = 284
TAG_TILE_WIDTH = 322
TAG_TILE_LENGTH = 323
TAG_TILE_OFFSETS = 324
TAG_TILE_BYTE_COUNTS = 325
TAG_SAMPLE_FORMAT = 339
TAG_MODEL_PIXEL_SCALE = 33550
TAG_MODEL_TIEPOINT = 33922
TAG_GEO_KEY_DIRECTORY = 34735

TYPE_SHORT = 3
TYPE_LONG = 4
TYPE_DOUBLE = 12
TILE_SIZE = 512

H5_FILES = [
    'test_data/NISAR_L2_PR_GCOV_013_155_D_091_2005_DHDH_A_20251226T231525_20251226T231556_P05006_N_F_J_001.h5',
    'test_data/NISAR_L2_PR_GCOV_013_120_D_075_2005_QPDH_A_20251224T125029_20251224T125103_P05006_N_F_J_001.h5',
    'test_data/NISAR_L2_PR_GCOV_014_120_D_074_2005_QPDH_A_20260105T124956_20260105T125030_P05006_N_F_J_001.h5',
]


def read_nisar_metadata(h5_path):
    """Read NISAR GCOV metadata — same logic as nisar-loader.js."""
    with h5py.File(h5_path, 'r') as f:
        band = None
        for b in ['LSAR', 'SSAR']:
            if f'/science/{b}/GCOV/grids/frequencyA' in f:
                band = b
                break
        assert band, "No LSAR or SSAR found"

        freq = 'A'
        base = f'/science/{band}/GCOV/grids/frequency{freq}'

        epsg = int(f[f'{base}/projection'][()])
        x_coords = f[f'{base}/xCoordinates'][:]
        y_coords = f[f'{base}/yCoordinates'][:]
        x_spacing = float(f[f'{base}/xCoordinateSpacing'][()])
        y_spacing = float(f[f'{base}/yCoordinateSpacing'][()])

        # Find polarization datasets by looking for actual 2D datasets
        pols = []
        for key in f[base].keys():
            ds_path = f'{base}/{key}'
            if ds_path in f and hasattr(f[ds_path], 'shape'):
                if len(f[ds_path].shape) == 2 and f[ds_path].shape[0] > 100:
                    pols.append(key)

        # Find 2D datasets (these are the actual data bands)
        data_shape = None
        for pol in pols:
            path = f'{base}/{pol}'
            if path in f and len(f[path].shape) == 2:
                data_shape = f[path].shape
                break

    width = len(x_coords)
    height = len(y_coords)

    # nisar-loader.js bounds logic: min/max of coordinate arrays
    min_x = float(min(x_coords[0], x_coords[-1]))
    max_x = float(max(x_coords[0], x_coords[-1]))
    min_y = float(min(y_coords[0], y_coords[-1]))
    max_y = float(max(y_coords[0], y_coords[-1]))

    return {
        'band': band,
        'freq': freq,
        'epsg': epsg,
        'width': width,
        'height': height,
        'bounds': [min_x, min_y, max_x, max_y],
        'x_spacing': abs(x_spacing),
        'y_spacing': abs(y_spacing),
        'pols': pols,
        'data_shape': data_shape,
    }


def read_nisar_band_stripe(h5_path, meta, pol, start_row, num_rows, ml):
    """Read a stripe of data with box-filter multilook — same as getExportStripe."""
    export_width = meta['width'] // ml
    band = meta['band']
    freq = meta['freq']
    base = f'/science/{band}/GCOV/grids/frequency{freq}'

    out = np.zeros(export_width * num_rows, dtype=np.float32)

    with h5py.File(h5_path, 'r') as f:
        ds_path = f'{base}/{pol}'
        if ds_path not in f:
            return out
        ds = f[ds_path]

        for oy in range(num_rows):
            for ox in range(export_width):
                sx0 = ox * ml
                sy0 = (start_row + oy) * ml
                sx1 = min(sx0 + ml, meta['width'])
                sy1 = min(sy0 + ml, meta['height'])

                # Read the ml×ml block
                block = ds[sy0:sy1, sx0:sx1]
                # Box-filter: average valid (>0) values
                valid = block[block > 0]
                if len(valid) > 0:
                    out[oy * export_width + ox] = np.mean(valid)

    return out


def write_float32_geotiff_js_style(path, bands, band_names, width, height,
                                    bounds, epsg_code):
    """Exact replica of writeFloat32GeoTIFF in geotiff-writer.js."""
    type_sizes = {TYPE_SHORT: 2, TYPE_LONG: 4, TYPE_DOUBLE: 8}
    num_bands = len(band_names)
    min_x, min_y, max_x, max_y = bounds
    pixel_scale_x = (max_x - min_x) / width
    pixel_scale_y = (max_y - min_y) / height

    # Tiles
    tiles_x = -(-width // TILE_SIZE)
    tiles_y = -(-height // TILE_SIZE)
    num_tiles = tiles_x * tiles_y
    compressed_tiles = []

    for ty in range(tiles_y):
        for tx in range(tiles_x):
            x0 = tx * TILE_SIZE
            y0 = ty * TILE_SIZE
            tile_w = min(TILE_SIZE, width - x0)
            tile_h = min(TILE_SIZE, height - y0)

            tile_data = np.zeros(TILE_SIZE * TILE_SIZE * num_bands,
                                 dtype=np.float32)
            for py in range(tile_h):
                for px in range(tile_w):
                    src_idx = (y0 + py) * width + (x0 + px)
                    dst_idx = (py * TILE_SIZE + px) * num_bands
                    for b in range(num_bands):
                        tile_data[dst_idx + b] = bands[band_names[b]][src_idx]

            compressed = zlib.compress(tile_data.tobytes(), 6)
            compressed_tiles.append({
                'data': compressed,
                'byteCount': len(compressed),
            })

    # IFD entries
    entries = [
        (TAG_IMAGE_WIDTH, TYPE_LONG, 1, [width]),
        (TAG_IMAGE_LENGTH, TYPE_LONG, 1, [height]),
        (TAG_BITS_PER_SAMPLE, TYPE_SHORT, num_bands, [32] * num_bands),
        (TAG_COMPRESSION, TYPE_SHORT, 1, [8]),
        (TAG_PHOTOMETRIC, TYPE_SHORT, 1, [1]),
        (TAG_SAMPLES_PER_PIXEL, TYPE_SHORT, 1, [num_bands]),
        (TAG_PLANAR_CONFIG, TYPE_SHORT, 1, [1]),
        (TAG_TILE_WIDTH, TYPE_LONG, 1, [TILE_SIZE]),
        (TAG_TILE_LENGTH, TYPE_LONG, 1, [TILE_SIZE]),
        (TAG_TILE_OFFSETS, TYPE_LONG, num_tiles, [0] * num_tiles),
        (TAG_TILE_BYTE_COUNTS, TYPE_LONG, num_tiles,
         [t['byteCount'] for t in compressed_tiles]),
        (TAG_SAMPLE_FORMAT, TYPE_SHORT, num_bands, [3] * num_bands),
        (TAG_MODEL_TIEPOINT, TYPE_DOUBLE, 6,
         [0, 0, 0, min_x, max_y, 0]),
        (TAG_MODEL_PIXEL_SCALE, TYPE_DOUBLE, 3,
         [pixel_scale_x, pixel_scale_y, 0]),
        (TAG_GEO_KEY_DIRECTORY, TYPE_SHORT, 16, [
            1, 1, 0, 3,
            1024, 0, 1, 1,   # GTModelTypeGeoKey = Projected
            1025, 0, 1, 1,   # GTRasterTypeGeoKey = PixelIsArea
            3072, 0, 1, epsg_code,
        ]),
    ]
    entries.sort(key=lambda e: e[0])

    # Layout
    header_size = 8
    ifd_size = 2 + len(entries) * 12 + 4
    ifd_offset = header_size
    overflow_size = 0
    for tag, typ, count, values in entries:
        bs = type_sizes[typ] * count
        if bs > 4:
            overflow_size += bs
            if overflow_size % 2 != 0:
                overflow_size += 1

    overflow_offset = ifd_offset + ifd_size
    tile_data_offset = overflow_offset + overflow_size
    total_tile_bytes = sum(t['byteCount'] for t in compressed_tiles)
    total_size = tile_data_offset + total_tile_bytes

    buf = bytearray(total_size)
    struct.pack_into('<2sHI', buf, 0, b'II', 42, ifd_offset)

    pos = ifd_offset
    struct.pack_into('<H', buf, pos, len(entries))
    pos += 2
    cur_overflow = overflow_offset

    for tag, typ, count, values in entries:
        byte_size = type_sizes[typ] * count
        struct.pack_into('<HHI', buf, pos, tag, typ, count)
        pos += 8

        if byte_size <= 4:
            if count == 1:
                if typ == TYPE_SHORT:
                    struct.pack_into('<H', buf, pos, int(values[0]))
                elif typ == TYPE_LONG:
                    struct.pack_into('<I', buf, pos, int(values[0]))
            elif count == 2 and typ == TYPE_SHORT:
                struct.pack_into('<HH', buf, pos,
                                int(values[0]), int(values[1]))
            pos += 4
        elif tag == TAG_TILE_OFFSETS:
            struct.pack_into('<I', buf, pos, cur_overflow)
            pos += 4
            tile_pos = tile_data_offset
            for j in range(len(compressed_tiles)):
                struct.pack_into('<I', buf, cur_overflow, tile_pos)
                cur_overflow += 4
                tile_pos += compressed_tiles[j]['byteCount']
            if cur_overflow % 2 != 0:
                cur_overflow += 1
        else:
            struct.pack_into('<I', buf, pos, cur_overflow)
            pos += 4
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

    struct.pack_into('<I', buf, pos, 0)

    tile_write_pos = tile_data_offset
    for tile in compressed_tiles:
        buf[tile_write_pos:tile_write_pos + tile['byteCount']] = tile['data']
        tile_write_pos += tile['byteCount']

    with open(path, 'wb') as f:
        f.write(buf)

    return pixel_scale_x, pixel_scale_y


def test_nisar_pipeline(h5_path, ml=4):
    """Test full SARdine export pipeline with a real NISAR file."""
    basename = os.path.basename(h5_path)
    print(f"\n{'='*70}")
    print(f"  Pipeline Test: {basename}")
    print(f"  Multilook: {ml}x{ml}")
    print(f"{'='*70}")

    # Step 1: Read metadata (same as nisar-loader.js)
    meta = read_nisar_metadata(h5_path)

    print(f"\n  HDF5 Metadata:")
    print(f"    Band: {meta['band']}")
    print(f"    EPSG: {meta['epsg']}")
    print(f"    Dimensions: {meta['width']} x {meta['height']}")
    print(f"    Native spacing: {meta['x_spacing']}m x {meta['y_spacing']}m")
    print(f"    Pixel-center bounds: {meta['bounds']}")
    print(f"    Polarizations: {meta['pols']}")

    source_width = meta['width']
    source_height = meta['height']

    # Step 2: main.jsx export logic
    effective_ml = ml
    while source_width // effective_ml > 8192:
        effective_ml *= 2

    export_width = source_width // effective_ml
    export_height = source_height // effective_ml

    # Bounds correction (pixel-center → pixel-edge)
    native_spacing_x = meta['x_spacing']
    native_spacing_y = meta['y_spacing']
    export_bounds = [
        meta['bounds'][0] - native_spacing_x / 2,
        meta['bounds'][1] - native_spacing_y / 2,
        meta['bounds'][2] + native_spacing_x / 2,
        meta['bounds'][3] + native_spacing_y / 2,
    ]

    export_pixel_x = (export_bounds[2] - export_bounds[0]) / export_width
    export_pixel_y = (export_bounds[3] - export_bounds[1]) / export_height
    expected_pixel_size = native_spacing_x * effective_ml

    print(f"\n  Export Parameters:")
    print(f"    Effective ML: {effective_ml}")
    print(f"    Export dims: {export_width} x {export_height}")
    print(f"    Export bounds (pixel-edge): {[f'{b:.2f}' for b in export_bounds]}")
    print(f"    Export pixel scale: {export_pixel_x:.6f} x {export_pixel_y:.6f}")
    print(f"    Expected pixel scale: {expected_pixel_size:.1f}m")
    print(f"    Scale match: {abs(export_pixel_x - expected_pixel_size) < 0.1}")

    # Step 3: Read actual data (use first 2 pols, limit to small export)
    # Use a small region to keep test fast
    max_export_rows = min(export_height, 100)
    band_names = meta['pols'][:min(3, len(meta['pols']))]

    print(f"\n  Reading {max_export_rows} rows of {len(band_names)} bands "
          f"({', '.join(band_names)})...")

    bands = {}
    for pol in band_names:
        print(f"    Reading {pol}...", end='', flush=True)
        stripe = read_nisar_band_stripe(
            h5_path, meta, pol, 0, max_export_rows, effective_ml)
        bands[pol] = stripe
        valid = stripe[stripe > 0]
        print(f" done. range=[{stripe.min():.4e}, {stripe.max():.4e}], "
              f"{len(valid)}/{len(stripe)} valid")

    test_width = export_width
    test_height = max_export_rows

    # Adjust bounds for the subset
    subset_bounds = [
        export_bounds[0],
        export_bounds[3] - test_height * export_pixel_y,
        export_bounds[2],
        export_bounds[3],
    ]

    print(f"\n  Subset bounds: {[f'{b:.2f}' for b in subset_bounds]}")

    # Step 4: Write with JS-style writer
    js_path = f'test_data/pipeline_{basename.split(".")[0]}_js.tif'
    print(f"\n  Writing JS-style: {js_path}")
    ps_x, ps_y = write_float32_geotiff_js_style(
        js_path, bands, band_names, test_width, test_height,
        subset_bounds, meta['epsg'])
    print(f"    File size: {os.path.getsize(js_path)} bytes")
    print(f"    Pixel scale written: {ps_x:.6f} x {ps_y:.6f}")

    # Step 5: Write with rasterio
    ref_path = f'test_data/pipeline_{basename.split(".")[0]}_ref.tif'
    print(f"\n  Writing reference: {ref_path}")
    transform = from_bounds(
        subset_bounds[0], subset_bounds[1],
        subset_bounds[2], subset_bounds[3],
        test_width, test_height)

    with rasterio.open(
        ref_path, 'w', driver='GTiff',
        width=test_width, height=test_height,
        count=len(band_names), dtype='float32',
        crs=CRS.from_epsg(meta['epsg']),
        transform=transform,
        tiled=True, blockxsize=512, blockysize=512,
        compress='deflate',
    ) as dst:
        for i, name in enumerate(band_names):
            data_2d = bands[name].reshape((test_height, test_width))
            dst.write(data_2d, i + 1)

    print(f"    File size: {os.path.getsize(ref_path)} bytes")

    # Step 6: Load both in rasterio and compare
    print(f"\n  {'─'*50}")
    print(f"  RASTERIO COMPARISON")
    print(f"  {'─'*50}")

    all_pass = True

    with rasterio.open(js_path) as js_src, \
         rasterio.open(ref_path) as ref_src:

        # Profile
        for key in ['driver', 'dtype', 'width', 'height', 'count',
                     'blockxsize', 'blockysize', 'tiled']:
            js_val = js_src.profile.get(key)
            ref_val = ref_src.profile.get(key)
            ok = js_val == ref_val
            if not ok:
                all_pass = False
            print(f"    [{'PASS' if ok else 'FAIL'}] {key}: "
                  f"JS={js_val} REF={ref_val}")

        print(f"    [INFO] JS  interleave: {js_src.interleaving}")
        print(f"    [INFO] REF interleave: {ref_src.interleaving}")

        # Transform
        js_t = js_src.transform
        ref_t = ref_src.transform
        for attr, name in [('a', 'pixel_x'), ('c', 'origin_x'),
                           ('e', 'pixel_y'), ('f', 'origin_y')]:
            js_v = getattr(js_t, attr)
            ref_v = getattr(ref_t, attr)
            ok = abs(js_v - ref_v) < 0.01
            if not ok:
                all_pass = False
            print(f"    [{'PASS' if ok else 'FAIL'}] {name}: "
                  f"JS={js_v:.4f} REF={ref_v:.4f}")

        # CRS
        js_epsg = js_src.crs.to_epsg() if js_src.crs else None
        ref_epsg = ref_src.crs.to_epsg() if ref_src.crs else None
        ok = js_epsg == ref_epsg == meta['epsg']
        if not ok:
            all_pass = False
        print(f"    [{'PASS' if ok else 'FAIL'}] EPSG: "
              f"JS={js_epsg} REF={ref_epsg} expected={meta['epsg']}")

        # Bounds
        js_b = js_src.bounds
        ref_b = ref_src.bounds
        for name, js_v, ref_v in [
            ('left', js_b.left, ref_b.left),
            ('bottom', js_b.bottom, ref_b.bottom),
            ('right', js_b.right, ref_b.right),
            ('top', js_b.top, ref_b.top),
        ]:
            ok = abs(js_v - ref_v) < 0.01
            if not ok:
                all_pass = False
            print(f"    [{'PASS' if ok else 'FAIL'}] bounds.{name}: "
                  f"JS={js_v:.2f} REF={ref_v:.2f}")

        # Data comparison
        print(f"\n  Band data comparison:")
        for bi in range(1, len(band_names) + 1):
            name = band_names[bi - 1]
            try:
                js_data = js_src.read(bi)
                ref_data = ref_src.read(bi)
                diff = np.abs(js_data - ref_data)
                max_diff = np.max(diff)
                ok = max_diff < 1e-5
                if not ok:
                    all_pass = False
                print(f"    [{'PASS' if ok else 'FAIL'}] {name}: "
                      f"max_diff={max_diff:.2e}, "
                      f"JS range=[{js_data.min():.4e},{js_data.max():.4e}], "
                      f"REF range=[{ref_data.min():.4e},{ref_data.max():.4e}]")
            except Exception as e:
                all_pass = False
                print(f"    [FAIL] {name}: {e}")

        # Spot checks
        print(f"\n  Spot checks (band 1):")
        js_d = js_src.read(1)
        ref_d = ref_src.read(1)
        for py, px, label in [(0, 0, "UL"), (0, test_width-1, "UR"),
                               (test_height-1, 0, "LL"),
                               (test_height-1, test_width-1, "LR"),
                               (test_height//2, test_width//2, "center")]:
            js_v = js_d[py, px]
            ref_v = ref_d[py, px]
            ok = abs(js_v - ref_v) < 1e-6
            if not ok:
                all_pass = False
            print(f"    [{'PASS' if ok else 'FAIL'}] {label} "
                  f"({px},{py}): JS={js_v:.6e} REF={ref_v:.6e}")

    # Step 7: Verify against HDF5 source
    print(f"\n  {'─'*50}")
    print(f"  GEOREF vs HDF5 SOURCE")
    print(f"  {'─'*50}")

    with rasterio.open(js_path) as src:
        t = src.transform
        b = src.bounds
        actual_epsg = src.crs.to_epsg() if src.crs else None

        # EPSG
        ok = actual_epsg == meta['epsg']
        if not ok:
            all_pass = False
        print(f"    [{'PASS' if ok else 'FAIL'}] EPSG: "
              f"{actual_epsg} (expected {meta['epsg']})")

        # Pixel scale
        ok = abs(t.a - export_pixel_x) < 0.01
        if not ok:
            all_pass = False
        print(f"    [{'PASS' if ok else 'FAIL'}] Pixel X: "
              f"{t.a:.4f}m (expected {export_pixel_x:.4f}m)")

        ok = abs(abs(t.e) - export_pixel_y) < 0.01
        if not ok:
            all_pass = False
        print(f"    [{'PASS' if ok else 'FAIL'}] Pixel Y: "
              f"{t.e:.4f}m (expected -{export_pixel_y:.4f}m)")

        # Y negative
        ok = t.e < 0
        if not ok:
            all_pass = False
        print(f"    [{'PASS' if ok else 'FAIL'}] Y scale negative (north-up)")

        # Origin at UL of pixel-edge bounds
        ok = abs(t.c - subset_bounds[0]) < 0.01
        if not ok:
            all_pass = False
        print(f"    [{'PASS' if ok else 'FAIL'}] Origin X: "
              f"{t.c:.2f} (expected {subset_bounds[0]:.2f})")

        ok = abs(t.f - subset_bounds[3]) < 0.01
        if not ok:
            all_pass = False
        print(f"    [{'PASS' if ok else 'FAIL'}] Origin Y: "
              f"{t.f:.2f} (expected {subset_bounds[3]:.2f})")

    print(f"\n  {'='*50}")
    print(f"  {'ALL PASS' if all_pass else 'SOME TESTS FAILED'}")
    print(f"  {'='*50}")

    return all_pass


def main():
    os.makedirs('test_data', exist_ok=True)

    h5_path = sys.argv[1] if len(sys.argv) > 1 else None
    if h5_path:
        files = [h5_path]
    else:
        files = [f for f in H5_FILES if os.path.exists(f)]

    if not files:
        print("No HDF5 files found. Provide a path or place files in test_data/")
        sys.exit(1)

    results = {}
    for f in files:
        for ml in [4, 8]:
            key = f"{os.path.basename(f)} ml={ml}"
            results[key] = test_nisar_pipeline(f, ml=ml)

    # Final summary
    print(f"\n\n{'='*70}")
    print(f"  FINAL SUMMARY")
    print(f"{'='*70}")
    for key, passed in results.items():
        print(f"  [{'PASS' if passed else 'FAIL'}] {key}")
    print(f"{'='*70}\n")

    all_ok = all(results.values())
    return all_ok


if __name__ == '__main__':
    success = main()
    sys.exit(0 if success else 1)
