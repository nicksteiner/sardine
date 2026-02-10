#!/usr/bin/env python3
"""
Test Float32 GeoTIFF Writer — validates the exact binary structure
produced by writeFloat32GeoTIFF in geotiff-writer.js.

Writes two GeoTIFFs with known data:
  1. "js_style"  — raw TIFF bytes matching our JS writer (BIP, tiled, DEFLATE)
  2. "reference" — written by rasterio (known-good)

Then reads both back with rasterio to check:
  - CRS, bounds, pixel scale
  - Band count, data type, data values
  - Tile structure
  - Identifies any structural issues

Usage:
    python3 scripts/test-float32-geotiff.py
"""

import sys
import os
import struct
import zlib
import numpy as np

try:
    import rasterio
    from rasterio.crs import CRS
    from rasterio.transform import from_bounds
except ImportError:
    print("ERROR: rasterio not found. Install with: pip install rasterio")
    sys.exit(1)


# ======================================================================
# TIFF constants (matching geotiff-writer.js)
# ======================================================================
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

KEY_GT_MODEL_TYPE = 1024
KEY_GT_RASTER_TYPE = 1025
KEY_PROJECTED_CS_TYPE = 3072
MODEL_TYPE_PROJECTED = 1
RASTER_TYPE_PIXEL_IS_AREA = 1


# ======================================================================
# Test parameters
# ======================================================================
# Use dimensions that aren't multiples of TILE_SIZE to test edge tiles
WIDTH = 700
HEIGHT = 600
NUM_BANDS = 3
BAND_NAMES = ['HHHH', 'HVHV', 'VVVV']
EPSG = 32718

# Bounds matching a typical NISAR scene (UTM zone 18S)
# These are pixel-EDGE bounds (already corrected)
BOUNDS = [434160.0, 9275760.0, 448160.0, 9287760.0]
# minX, minY, maxX, maxY
# pixel scale: (14000/700, 12000/600) = (20.0, 20.0)

OUT_DIR = 'test_data'


def create_test_bands(width, height, band_names):
    """Create test Float32 band data with known patterns."""
    bands = {}
    for i, name in enumerate(band_names):
        data = np.zeros((height, width), dtype=np.float32)
        # Fill with recognizable patterns
        # Band 0: horizontal gradient (increases with x)
        # Band 1: vertical gradient (increases with y)
        # Band 2: diagonal gradient
        for y in range(height):
            for x in range(width):
                if i == 0:
                    data[y, x] = float(x) / width
                elif i == 1:
                    data[y, x] = float(y) / height
                else:
                    data[y, x] = float(x + y) / (width + height)
        # Flatten to 1D (same as JS Float32Array)
        bands[name] = data.flatten()
    return bands


def write_float32_geotiff_js_style(path, bands, band_names, width, height,
                                    bounds, epsg_code):
    """
    Write a Float32 GeoTIFF using the EXACT same logic as
    writeFloat32GeoTIFF in geotiff-writer.js.

    This is a line-by-line Python port for testing.
    """
    num_bands = len(band_names)
    min_x, min_y, max_x, max_y = bounds
    pixel_scale_x = (max_x - min_x) / width
    pixel_scale_y = (max_y - min_y) / height

    # --- Step 1: Extract and compress 512x512 tiles ---
    tiles_x = -(-width // TILE_SIZE)   # ceil division
    tiles_y = -(-height // TILE_SIZE)
    num_tiles = tiles_x * tiles_y
    compressed_tiles = []

    for ty in range(tiles_y):
        for tx in range(tiles_x):
            x0 = tx * TILE_SIZE
            y0 = ty * TILE_SIZE
            tile_w = min(TILE_SIZE, width - x0)
            tile_h = min(TILE_SIZE, height - y0)

            # Extract tile: BIP layout (band-interleaved-by-pixel)
            tile_data = np.zeros(TILE_SIZE * TILE_SIZE * num_bands,
                                 dtype=np.float32)

            for py in range(tile_h):
                for px in range(tile_w):
                    src_idx = (y0 + py) * width + (x0 + px)
                    dst_idx = (py * TILE_SIZE + px) * num_bands
                    for b in range(num_bands):
                        tile_data[dst_idx + b] = bands[band_names[b]][src_idx]

            # Compress raw bytes with DEFLATE (level 6)
            tile_bytes = tile_data.tobytes()
            compressed = zlib.compress(tile_bytes, 6)
            compressed_tiles.append({
                'data': compressed,
                'byteCount': len(compressed),
            })

    # --- Step 2: Build IFD entries ---
    type_sizes = {TYPE_SHORT: 2, TYPE_LONG: 4, TYPE_DOUBLE: 8}

    # entries: list of (tag, type, count, values[])
    entries = []

    entries.append((TAG_IMAGE_WIDTH, TYPE_LONG, 1, [width]))
    entries.append((TAG_IMAGE_LENGTH, TYPE_LONG, 1, [height]))
    entries.append((TAG_BITS_PER_SAMPLE, TYPE_SHORT, num_bands,
                    [32] * num_bands))
    entries.append((TAG_COMPRESSION, TYPE_SHORT, 1, [8]))  # DEFLATE
    entries.append((TAG_PHOTOMETRIC, TYPE_SHORT, 1, [1]))  # MinIsBlack
    entries.append((TAG_SAMPLES_PER_PIXEL, TYPE_SHORT, 1, [num_bands]))
    entries.append((TAG_PLANAR_CONFIG, TYPE_SHORT, 1, [1]))  # chunky/BIP
    entries.append((TAG_TILE_WIDTH, TYPE_LONG, 1, [TILE_SIZE]))
    entries.append((TAG_TILE_LENGTH, TYPE_LONG, 1, [TILE_SIZE]))
    entries.append((TAG_TILE_OFFSETS, TYPE_LONG, num_tiles, [0] * num_tiles))
    entries.append((TAG_TILE_BYTE_COUNTS, TYPE_LONG, num_tiles,
                    [t['byteCount'] for t in compressed_tiles]))
    entries.append((TAG_SAMPLE_FORMAT, TYPE_SHORT, num_bands,
                    [3] * num_bands))  # IEEE float

    # GeoTIFF tags
    entries.append((TAG_MODEL_TIEPOINT, TYPE_DOUBLE, 6,
                    [0, 0, 0, min_x, max_y, 0]))
    entries.append((TAG_MODEL_PIXEL_SCALE, TYPE_DOUBLE, 3,
                    [pixel_scale_x, pixel_scale_y, 0]))
    entries.append((TAG_GEO_KEY_DIRECTORY, TYPE_SHORT, 16, [
        1, 1, 0, 3,
        KEY_GT_MODEL_TYPE, 0, 1, MODEL_TYPE_PROJECTED,
        KEY_GT_RASTER_TYPE, 0, 1, RASTER_TYPE_PIXEL_IS_AREA,
        KEY_PROJECTED_CS_TYPE, 0, 1, epsg_code,
    ]))

    # Sort by tag
    entries.sort(key=lambda e: e[0])

    # --- Step 3: Calculate file layout ---
    header_size = 8
    ifd_size = 2 + len(entries) * 12 + 4
    ifd_offset = header_size

    # Overflow data
    overflow_size = 0
    overflow_entries = []  # indices of entries that need overflow
    for i, (tag, typ, count, values) in enumerate(entries):
        byte_size = type_sizes[typ] * count
        if byte_size > 4:
            overflow_entries.append(i)
            overflow_size += byte_size
            if overflow_size % 2 != 0:
                overflow_size += 1

    overflow_offset = ifd_offset + ifd_size
    tile_data_offset = overflow_offset + overflow_size
    total_tile_bytes = sum(t['byteCount'] for t in compressed_tiles)
    total_size = tile_data_offset + total_tile_bytes

    # --- Step 4: Write the file ---
    buf = bytearray(total_size)

    # TIFF header
    struct.pack_into('<2sHI', buf, 0, b'II', 42, ifd_offset)

    # Write IFD
    pos = ifd_offset
    struct.pack_into('<H', buf, pos, len(entries))
    pos += 2

    cur_overflow = overflow_offset

    for i, (tag, typ, count, values) in enumerate(entries):
        byte_size = type_sizes[typ] * count

        struct.pack_into('<HHI', buf, pos, tag, typ, count)
        pos += 8

        if byte_size <= 4:
            # Inline value
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
            # Write pointer to overflow, then fill in tile offsets
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
            # Other overflow arrays
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

    # Next IFD pointer = 0
    struct.pack_into('<I', buf, pos, 0)

    # Write tile data
    tile_write_pos = tile_data_offset
    for tile in compressed_tiles:
        buf[tile_write_pos:tile_write_pos + tile['byteCount']] = tile['data']
        tile_write_pos += tile['byteCount']

    with open(path, 'wb') as f:
        f.write(buf)

    return pixel_scale_x, pixel_scale_y


def write_reference_geotiff(path, bands, band_names, width, height,
                             bounds, epsg_code):
    """Write a reference GeoTIFF using rasterio (known-good)."""
    min_x, min_y, max_x, max_y = bounds
    transform = from_bounds(min_x, min_y, max_x, max_y, width, height)

    with rasterio.open(
        path, 'w',
        driver='GTiff',
        width=width,
        height=height,
        count=len(band_names),
        dtype='float32',
        crs=CRS.from_epsg(epsg_code),
        transform=transform,
        tiled=True,
        blockxsize=512,
        blockysize=512,
        compress='deflate',
    ) as dst:
        for i, name in enumerate(band_names):
            data_2d = bands[name].reshape((height, width))
            dst.write(data_2d, i + 1)
            dst.set_band_description(i + 1, name)


def verify_geotiff(path, expected_bounds, expected_epsg, expected_width,
                    expected_height, expected_num_bands, label=""):
    """Verify a GeoTIFF with rasterio and return pass/fail dict."""
    results = {}
    print(f"\n{'─'*50}")
    print(f"  {label}: {os.path.basename(path)}")
    print(f"{'─'*50}")

    try:
        src = rasterio.open(path)
    except Exception as e:
        print(f"  FATAL: Cannot open file: {e}")
        return {'open': False}

    with src:
        t = src.transform
        b = src.bounds

        print(f"  Dimensions: {src.width} x {src.height}, {src.count} bands")
        print(f"  Dtype: {src.dtypes}")
        print(f"  CRS: {src.crs}")
        print(f"  Origin (UL): ({t.c:.2f}, {t.f:.2f})")
        print(f"  Pixel size: ({t.a:.6f}, {t.e:.6f})")
        print(f"  Bounds: [{b.left:.2f}, {b.bottom:.2f}, "
              f"{b.right:.2f}, {b.top:.2f}]")

        # Block structure
        for bi in range(1, min(src.count + 1, 4)):
            bs = src.block_shapes[bi - 1]
            print(f"  Band {bi} block shape: {bs}")

        # Check 1: Opens at all
        results['open'] = True
        status = 'PASS'
        print(f"\n  [{status}] File opens successfully")

        # Check 2: CRS
        actual_epsg = src.crs.to_epsg() if src.crs else None
        ok = actual_epsg == expected_epsg
        results['crs'] = ok
        print(f"  [{'PASS' if ok else 'FAIL'}] EPSG: {actual_epsg} "
              f"(expected {expected_epsg})")

        # Check 3: Dimensions
        ok = src.width == expected_width and src.height == expected_height
        results['dimensions'] = ok
        print(f"  [{'PASS' if ok else 'FAIL'}] Dimensions: "
              f"{src.width}x{src.height} "
              f"(expected {expected_width}x{expected_height})")

        # Check 4: Band count
        ok = src.count == expected_num_bands
        results['band_count'] = ok
        print(f"  [{'PASS' if ok else 'FAIL'}] Bands: {src.count} "
              f"(expected {expected_num_bands})")

        # Check 5: Data type
        ok = all(d == 'float32' for d in src.dtypes)
        results['dtype'] = ok
        print(f"  [{'PASS' if ok else 'FAIL'}] Data type: {src.dtypes}")

        # Check 6: Bounds
        min_x, min_y, max_x, max_y = expected_bounds
        ok = (abs(b.left - min_x) < 1.0 and
              abs(b.bottom - min_y) < 1.0 and
              abs(b.right - max_x) < 1.0 and
              abs(b.top - max_y) < 1.0)
        results['bounds'] = ok
        print(f"  [{'PASS' if ok else 'FAIL'}] Bounds match expected")
        if not ok:
            print(f"    Actual:   [{b.left:.2f}, {b.bottom:.2f}, "
                  f"{b.right:.2f}, {b.top:.2f}]")
            print(f"    Expected: [{min_x:.2f}, {min_y:.2f}, "
                  f"{max_x:.2f}, {max_y:.2f}]")

        # Check 7: Pixel scale
        expected_ps_x = (max_x - min_x) / expected_width
        expected_ps_y = (max_y - min_y) / expected_height
        ok = (abs(t.a - expected_ps_x) < 0.01 and
              abs(abs(t.e) - expected_ps_y) < 0.01)
        results['pixel_scale'] = ok
        print(f"  [{'PASS' if ok else 'FAIL'}] Pixel scale: "
              f"({t.a:.6f}, {t.e:.6f}) "
              f"(expected {expected_ps_x:.6f}, -{expected_ps_y:.6f})")

        # Check 8: Y pixel scale negative (north-up)
        ok = t.e < 0
        results['y_negative'] = ok
        print(f"  [{'PASS' if ok else 'FAIL'}] Y pixel scale negative "
              f"(north-up): {t.e:.6f}")

        # Check 9: Origin at UL
        ok = (abs(t.c - min_x) < 0.01 and abs(t.f - max_y) < 0.01)
        results['origin'] = ok
        print(f"  [{'PASS' if ok else 'FAIL'}] Origin at UL: "
              f"({t.c:.2f}, {t.f:.2f}) "
              f"(expected {min_x:.2f}, {max_y:.2f})")

        # Check 10: Can read data without crash
        try:
            data = src.read(1)
            ok = data is not None and data.shape == (expected_height,
                                                      expected_width)
            results['read_data'] = ok
            print(f"  [{'PASS' if ok else 'FAIL'}] Can read band 1: "
                  f"shape={data.shape}, "
                  f"min={np.nanmin(data):.4f}, max={np.nanmax(data):.4f}")

            # Check data values (band 1 = horizontal gradient 0→1)
            expected_center = 0.5
            actual_center = data[expected_height // 2, expected_width // 2]
            ok = abs(actual_center - expected_center) < 0.05
            results['data_values'] = ok
            print(f"  [{'PASS' if ok else 'FAIL'}] Center pixel band 1: "
                  f"{actual_center:.4f} (expected ~{expected_center:.4f})")
        except Exception as e:
            results['read_data'] = False
            results['data_values'] = False
            print(f"  [FAIL] Read data crashed: {e}")

        # Check 11: Can read all bands
        try:
            all_data = src.read()
            ok = all_data.shape == (expected_num_bands, expected_height,
                                     expected_width)
            results['read_all_bands'] = ok
            print(f"  [{'PASS' if ok else 'FAIL'}] Read all bands: "
                  f"shape={all_data.shape}")
        except Exception as e:
            results['read_all_bands'] = False
            print(f"  [FAIL] Read all bands crashed: {e}")

    return results


def compare_geotiffs(js_path, ref_path, input_bands, band_names, width,
                      height):
    """Load both GeoTIFFs in rasterio and do pixel-level comparison."""
    print(f"\n{'='*60}")
    print(f"  RASTERIO SIDE-BY-SIDE COMPARISON")
    print(f"{'='*60}")

    all_pass = True

    with rasterio.open(js_path) as js_src, \
         rasterio.open(ref_path) as ref_src:

        # --- Profile comparison ---
        print(f"\n  Profile comparison:")
        for key in ['driver', 'dtype', 'width', 'height', 'count',
                     'blockxsize', 'blockysize', 'tiled']:
            js_val = js_src.profile.get(key)
            ref_val = ref_src.profile.get(key)
            ok = js_val == ref_val
            if not ok:
                all_pass = False
            print(f"    [{'PASS' if ok else 'FAIL'}] {key}: "
                  f"JS={js_val}  REF={ref_val}")

        # Compression (may differ in name but be equivalent)
        js_comp = js_src.profile.get('compress', 'none')
        ref_comp = ref_src.profile.get('compress', 'none')
        print(f"    [INFO] compress: JS={js_comp}  REF={ref_comp}")

        # Interleaving
        js_il = str(js_src.interleaving)
        ref_il = str(ref_src.interleaving)
        ok = js_il == ref_il
        print(f"    [{'PASS' if ok else 'WARN'}] interleave: "
              f"JS={js_il}  REF={ref_il}")

        # --- Transform comparison ---
        print(f"\n  Transform comparison:")
        js_t = js_src.transform
        ref_t = ref_src.transform
        for attr, name in [('a', 'pixel_x'), ('b', 'shear_x'),
                           ('c', 'origin_x'), ('d', 'shear_y'),
                           ('e', 'pixel_y'), ('f', 'origin_y')]:
            js_v = getattr(js_t, attr)
            ref_v = getattr(ref_t, attr)
            ok = abs(js_v - ref_v) < 0.001
            if not ok:
                all_pass = False
            print(f"    [{'PASS' if ok else 'FAIL'}] {name}: "
                  f"JS={js_v:.6f}  REF={ref_v:.6f}")

        # --- CRS comparison ---
        js_epsg = js_src.crs.to_epsg() if js_src.crs else None
        ref_epsg = ref_src.crs.to_epsg() if ref_src.crs else None
        ok = js_epsg == ref_epsg
        if not ok:
            all_pass = False
        print(f"\n    [{'PASS' if ok else 'FAIL'}] EPSG: "
              f"JS={js_epsg}  REF={ref_epsg}")

        # --- Band data comparison ---
        print(f"\n  Band data comparison:")
        for bi in range(1, len(band_names) + 1):
            name = band_names[bi - 1]

            try:
                js_data = js_src.read(bi)
                ref_data = ref_src.read(bi)
            except Exception as e:
                print(f"    [FAIL] Band {bi} ({name}): read error: {e}")
                all_pass = False
                continue

            # Shape
            ok = js_data.shape == ref_data.shape
            if not ok:
                all_pass = False
                print(f"    [FAIL] Band {bi} ({name}): shape mismatch: "
                      f"JS={js_data.shape}  REF={ref_data.shape}")
                continue

            # Value comparison
            diff = np.abs(js_data - ref_data)
            max_diff = np.max(diff)
            mean_diff = np.mean(diff)
            ok = max_diff < 1e-6
            if not ok:
                all_pass = False

            # Compare against input
            input_2d = input_bands[name].reshape((height, width))
            js_vs_input = np.abs(js_data - input_2d)
            ref_vs_input = np.abs(ref_data - input_2d)
            js_max_err = np.max(js_vs_input)
            ref_max_err = np.max(ref_vs_input)

            print(f"    [{'PASS' if ok else 'FAIL'}] Band {bi} ({name}):")
            print(f"      JS  range: [{np.min(js_data):.6f}, "
                  f"{np.max(js_data):.6f}]")
            print(f"      REF range: [{np.min(ref_data):.6f}, "
                  f"{np.max(ref_data):.6f}]")
            print(f"      JS-vs-REF: max_diff={max_diff:.2e}, "
                  f"mean_diff={mean_diff:.2e}")
            print(f"      JS-vs-INPUT:  max_err={js_max_err:.2e}")
            print(f"      REF-vs-INPUT: max_err={ref_max_err:.2e}")

            if not ok:
                # Find where differences are largest
                bad_y, bad_x = np.unravel_index(np.argmax(diff), diff.shape)
                print(f"      Worst diff at pixel ({bad_x}, {bad_y}): "
                      f"JS={js_data[bad_y, bad_x]:.6f}, "
                      f"REF={ref_data[bad_y, bad_x]:.6f}, "
                      f"INPUT={input_2d[bad_y, bad_x]:.6f}")

        # --- Check specific pixels ---
        print(f"\n  Spot-check pixels:")
        test_pixels = [
            (0, 0, "UL corner"),
            (width - 1, 0, "UR corner"),
            (0, height - 1, "LL corner"),
            (width - 1, height - 1, "LR corner"),
            (width // 2, height // 2, "center"),
            (511, 511, "last pixel of tile (0,0)"),
            (512, 0, "first pixel of tile (1,0)"),
            (0, 512, "first pixel of tile (0,1)"),
        ]

        for px, py, label in test_pixels:
            if px >= width or py >= height:
                continue
            input_val = input_bands[band_names[0]][py * width + px]
            js_val = js_src.read(1, window=rasterio.windows.Window(px, py, 1, 1))[0, 0]
            ref_val = ref_src.read(1, window=rasterio.windows.Window(px, py, 1, 1))[0, 0]
            ok = abs(js_val - ref_val) < 1e-6 and abs(js_val - input_val) < 1e-6
            if not ok:
                all_pass = False
            print(f"    [{'PASS' if ok else 'FAIL'}] {label} ({px},{py}): "
                  f"input={input_val:.6f}, JS={js_val:.6f}, "
                  f"REF={ref_val:.6f}")

    return all_pass


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    print(f"\n{'='*60}")
    print(f"  Float32 GeoTIFF Writer Test")
    print(f"{'='*60}")
    print(f"  Dimensions: {WIDTH} x {HEIGHT}")
    print(f"  Bands: {NUM_BANDS} ({', '.join(BAND_NAMES)})")
    print(f"  EPSG: {EPSG}")
    print(f"  Bounds: {BOUNDS}")
    print(f"  Tile size: {TILE_SIZE}")

    # Create test data
    print("\nCreating test band data...")
    bands = create_test_bands(WIDTH, HEIGHT, BAND_NAMES)
    for name in BAND_NAMES:
        print(f"  {name}: shape={bands[name].shape}, "
              f"min={bands[name].min():.4f}, max={bands[name].max():.4f}")

    # Write JS-style GeoTIFF
    js_path = os.path.join(OUT_DIR, 'test_float32_js_style.tif')
    print(f"\nWriting JS-style GeoTIFF: {js_path}")
    ps_x, ps_y = write_float32_geotiff_js_style(
        js_path, bands, BAND_NAMES, WIDTH, HEIGHT, BOUNDS, EPSG)
    print(f"  Pixel scale: {ps_x:.6f} x {ps_y:.6f}")
    print(f"  File size: {os.path.getsize(js_path)} bytes")

    # Write reference GeoTIFF
    ref_path = os.path.join(OUT_DIR, 'test_float32_reference.tif')
    print(f"\nWriting reference GeoTIFF: {ref_path}")
    write_reference_geotiff(
        ref_path, bands, BAND_NAMES, WIDTH, HEIGHT, BOUNDS, EPSG)
    print(f"  File size: {os.path.getsize(ref_path)} bytes")

    # Verify each independently
    js_results = verify_geotiff(
        js_path, BOUNDS, EPSG, WIDTH, HEIGHT, NUM_BANDS,
        label="JS-STYLE (our writer)")

    ref_results = verify_geotiff(
        ref_path, BOUNDS, EPSG, WIDTH, HEIGHT, NUM_BANDS,
        label="REFERENCE (rasterio)")

    # Side-by-side comparison: load both in rasterio
    compare_pass = compare_geotiffs(
        js_path, ref_path, bands, BAND_NAMES, WIDTH, HEIGHT)

    # Try gdalinfo if available
    print(f"\n{'='*60}")
    print(f"  GDAL VALIDATION")
    print(f"{'='*60}")
    import subprocess
    for label, path in [("JS-STYLE", js_path), ("REFERENCE", ref_path)]:
        try:
            result = subprocess.run(
                ['gdalinfo', '-checksum', path],
                capture_output=True, text=True, timeout=10)
            print(f"\n  {label} gdalinfo:")
            for line in result.stdout.strip().split('\n'):
                print(f"    {line}")
            if result.stderr.strip():
                print(f"    WARNINGS: {result.stderr.strip()}")
        except FileNotFoundError:
            print(f"\n  gdalinfo not found — skipping GDAL validation")
            break
        except Exception as e:
            print(f"\n  {label} gdalinfo error: {e}")

    # Final summary
    all_js = all(v for v in js_results.values())
    all_ref = all(v for v in ref_results.values())

    print(f"\n{'='*60}")
    print(f"  FINAL SUMMARY")
    print(f"{'='*60}")
    print(f"  JS-style writer:   {'ALL PASS' if all_js else 'SOME FAIL'}")
    print(f"  Reference writer:  {'ALL PASS' if all_ref else 'SOME FAIL'}")
    print(f"  Data comparison:   {'ALL PASS' if compare_pass else 'DIFFERENCES FOUND'}")
    print(f"{'='*60}\n")

    return all_js and all_ref and compare_pass


if __name__ == '__main__':
    success = main()
    sys.exit(0 if success else 1)
