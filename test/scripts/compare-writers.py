#!/usr/bin/env python3
"""
Compare SARdine GeoTIFF writer vs rasterio writer.

Reads real NISAR GCOV data, writes two TIFs with identical data:
  - rasterio_output.tif  (rasterio — the gold standard)
  - sardine_output.tif   (SARdine JS-style binary writer)

Both should open identically in QGIS. Run and inspect.

Usage:
    python3 test/scripts/compare-writers.py [path-to-h5] [--ml 8]
"""

import sys
import os
import struct
import zlib
import argparse
import numpy as np
import h5py

try:
    import rasterio
    from rasterio.crs import CRS
    from rasterio.transform import from_bounds
except ImportError:
    print("ERROR: pip install rasterio")
    sys.exit(1)


# ─── NISAR reader ───────────────────────────────────────────────────────────

COVARIANCE_POLS = {'HHHH', 'HVHV', 'VHVH', 'VVVV', 'HHHV', 'HHVV', 'HVVV'}

def read_nisar(h5_path):
    """Read NISAR GCOV metadata and return info dict."""
    with h5py.File(h5_path, 'r') as f:
        band = next((b for b in ['LSAR', 'SSAR']
                     if f'/science/{b}/GCOV/grids/frequencyA' in f), None)
        assert band, "No LSAR/SSAR found"
        base = f'/science/{band}/GCOV/grids/frequencyA'

        epsg = int(f[f'{base}/projection'][()])
        x = f[f'{base}/xCoordinates'][:]
        y = f[f'{base}/yCoordinates'][:]
        x_sp = abs(float(f[f'{base}/xCoordinateSpacing'][()]))
        y_sp = abs(float(f[f'{base}/yCoordinateSpacing'][()]))

        # Find actual polarization 2D datasets
        pols = [k for k in f[base].keys()
                if k in COVARIANCE_POLS
                and f'{base}/{k}' in f
                and len(f[f'{base}/{k}'].shape) == 2]

    return {
        'path': h5_path, 'band': band, 'epsg': epsg,
        'width': len(x), 'height': len(y),
        'x_spacing': x_sp, 'y_spacing': y_sp,
        'bounds': [float(min(x[0],x[-1])), float(min(y[0],y[-1])),
                   float(max(x[0],x[-1])), float(max(y[0],y[-1]))],
        'pols': sorted(pols),
    }


def read_bands(meta, ml, max_rows=None):
    """Read and multilook NISAR bands using numpy (fast)."""
    w, h = meta['width'], meta['height']
    ew, eh = w // ml, h // ml
    if max_rows:
        eh = min(eh, max_rows)

    # Source rows to read
    src_rows = eh * ml

    bands = {}
    with h5py.File(meta['path'], 'r') as f:
        base = f'/science/{meta["band"]}/GCOV/grids/frequencyA'
        for pol in meta['pols']:
            print(f"  Reading {pol} [{w}x{src_rows}] -> [{ew}x{eh}] ...", end='', flush=True)
            raw = f[f'{base}/{pol}'][:src_rows, :ew * ml].astype(np.float32)

            # Box-filter multilook: reshape to (eh, ml, ew, ml) then mean
            reshaped = raw.reshape(eh, ml, ew, ml)
            # Replace zeros/negatives with NaN for averaging, then fill back with 0
            reshaped = np.where(reshaped > 0, reshaped, np.nan)
            avg = np.nanmean(reshaped, axis=(1, 3)).astype(np.float32)
            avg = np.nan_to_num(avg, nan=0.0)

            bands[pol] = avg.ravel()
            valid = bands[pol][bands[pol] > 0]
            print(f" {len(valid)}/{ew*eh} valid, "
                  f"range [{bands[pol].min():.2e}, {bands[pol].max():.2e}]")

    return bands, ew, eh


# ─── SARdine-style TIFF writer (exact replica of geotiff-writer.js) ─────────

TAG_WIDTH = 256; TAG_LENGTH = 257; TAG_BPS = 258; TAG_COMPRESS = 259
TAG_PHOTO = 262; TAG_SPP = 277; TAG_PLANAR = 284
TAG_TILEW = 322; TAG_TILEL = 323; TAG_TILEOFF = 324; TAG_TILEBC = 325
TAG_SFORMAT = 339; TAG_SCALE = 33550; TAG_TIEPOINT = 33922; TAG_GEOKEYS = 34735
T_SHORT = 3; T_LONG = 4; T_DOUBLE = 12
TILE = 512
TYPE_SZ = {T_SHORT: 2, T_LONG: 4, T_DOUBLE: 8}


def sardine_write(path, bands, names, w, h, bounds, epsg):
    """Exact binary replica of writeFloat32GeoTIFF() from geotiff-writer.js."""
    nb = len(names)
    minx, miny, maxx, maxy = bounds
    psx = (maxx - minx) / w
    psy = (maxy - miny) / h

    # Compress 512x512 BIP tiles
    tx_n = -(-w // TILE)
    ty_n = -(-h // TILE)
    tiles = []
    for ty in range(ty_n):
        for tx in range(tx_n):
            x0, y0 = tx * TILE, ty * TILE
            tw = min(TILE, w - x0)
            th = min(TILE, h - y0)
            buf = np.zeros(TILE * TILE * nb, dtype=np.float32)
            for py in range(th):
                for px in range(tw):
                    si = (y0 + py) * w + (x0 + px)
                    di = (py * TILE + px) * nb
                    for b in range(nb):
                        buf[di + b] = bands[names[b]][si]
            tiles.append(zlib.compress(buf.tobytes(), 6))

    # IFD entries: (tag, type, count, values[])
    entries = sorted([
        (TAG_WIDTH,    T_LONG,   1,       [w]),
        (TAG_LENGTH,   T_LONG,   1,       [h]),
        (TAG_BPS,      T_SHORT,  nb,      [32]*nb),
        (TAG_COMPRESS, T_SHORT,  1,       [8]),
        (TAG_PHOTO,    T_SHORT,  1,       [1]),
        (TAG_SPP,      T_SHORT,  1,       [nb]),
        (TAG_PLANAR,   T_SHORT,  1,       [1]),
        (TAG_TILEW,    T_LONG,   1,       [TILE]),
        (TAG_TILEL,    T_LONG,   1,       [TILE]),
        (TAG_TILEOFF,  T_LONG,   len(tiles), [0]*len(tiles)),
        (TAG_TILEBC,   T_LONG,   len(tiles), [len(t) for t in tiles]),
        (TAG_SFORMAT,  T_SHORT,  nb,      [3]*nb),
        (TAG_TIEPOINT, T_DOUBLE, 6,       [0,0,0, minx, maxy, 0]),
        (TAG_SCALE,    T_DOUBLE, 3,       [psx, psy, 0]),
        (TAG_GEOKEYS,  T_SHORT,  16,      [1,1,0,3, 1024,0,1,1, 1025,0,1,1, 3072,0,1,epsg]),
    ], key=lambda e: e[0])

    # Layout: header(8) + IFD + overflow + tile data
    ifd_off = 8
    ifd_sz = 2 + len(entries) * 12 + 4
    overflow_sz = 0
    for _, typ, cnt, _ in entries:
        bs = TYPE_SZ[typ] * cnt
        if bs > 4:
            overflow_sz += bs
            if overflow_sz % 2: overflow_sz += 1

    ovf_off = ifd_off + ifd_sz
    tile_off = ovf_off + overflow_sz
    total = tile_off + sum(len(t) for t in tiles)
    buf = bytearray(total)

    # Header
    struct.pack_into('<2sHI', buf, 0, b'II', 42, ifd_off)

    # IFD
    pos = ifd_off
    struct.pack_into('<H', buf, pos, len(entries)); pos += 2
    cur_ovf = ovf_off

    for tag, typ, cnt, vals in entries:
        bsz = TYPE_SZ[typ] * cnt
        struct.pack_into('<HHI', buf, pos, tag, typ, cnt); pos += 8

        if bsz <= 4:
            if cnt == 1:
                if typ == T_SHORT:
                    struct.pack_into('<H', buf, pos, int(vals[0]))
                elif typ == T_LONG:
                    struct.pack_into('<I', buf, pos, int(vals[0]))
            elif cnt == 2 and typ == T_SHORT:
                struct.pack_into('<HH', buf, pos, int(vals[0]), int(vals[1]))
            pos += 4
        elif tag == TAG_TILEOFF:
            struct.pack_into('<I', buf, pos, cur_ovf); pos += 4
            tp = tile_off
            for t in tiles:
                struct.pack_into('<I', buf, cur_ovf, tp)
                cur_ovf += 4; tp += len(t)
            if cur_ovf % 2: cur_ovf += 1
        else:
            struct.pack_into('<I', buf, pos, cur_ovf); pos += 4
            op = cur_ovf
            for v in vals:
                if typ == T_SHORT:
                    struct.pack_into('<H', buf, op, int(v)); op += 2
                elif typ == T_LONG:
                    struct.pack_into('<I', buf, op, int(v)); op += 4
                elif typ == T_DOUBLE:
                    struct.pack_into('<d', buf, op, float(v)); op += 8
            cur_ovf += bsz
            if cur_ovf % 2: cur_ovf += 1

    struct.pack_into('<I', buf, pos, 0)  # next IFD = 0

    # Tile data
    wp = tile_off
    for t in tiles:
        buf[wp:wp+len(t)] = t; wp += len(t)

    with open(path, 'wb') as f:
        f.write(buf)


# ─── rasterio writer ────────────────────────────────────────────────────────

def rasterio_write(path, bands, names, w, h, bounds, epsg):
    """Write the exact same data using rasterio (the gold standard)."""
    transform = from_bounds(bounds[0], bounds[1], bounds[2], bounds[3], w, h)
    with rasterio.open(
        path, 'w', driver='GTiff',
        width=w, height=h,
        count=len(names), dtype='float32',
        crs=CRS.from_epsg(epsg),
        transform=transform,
        tiled=True, blockxsize=512, blockysize=512,
        compress='deflate',
    ) as dst:
        for i, name in enumerate(names):
            dst.write(bands[name].reshape(h, w), i + 1)


# ─── Comparison ──────────────────────────────────────────────────────────────

def compare(sardine_path, rasterio_path):
    """Open both TIFs in rasterio and compare everything."""
    print("\n" + "="*60)
    print("  COMPARISON: sardine vs rasterio")
    print("="*60)
    ok_all = True

    with rasterio.open(sardine_path) as s, rasterio.open(rasterio_path) as r:
        # Profile checks
        for key in ['driver', 'dtype', 'width', 'height', 'count']:
            sv, rv = s.profile[key], r.profile[key]
            ok = sv == rv
            ok_all &= ok
            mark = "PASS" if ok else "FAIL"
            print(f"  [{mark}] {key}: sardine={sv}  rasterio={rv}")

        # CRS
        se = s.crs.to_epsg() if s.crs else None
        re = r.crs.to_epsg() if r.crs else None
        ok = se == re
        ok_all &= ok
        print(f"  [{'PASS' if ok else 'FAIL'}] EPSG: sardine={se}  rasterio={re}")

        # Transform (origin + pixel scale)
        st, rt = s.transform, r.transform
        for attr, label in [('a','pixel_x'), ('c','origin_x'),
                            ('e','pixel_y'), ('f','origin_y')]:
            sv, rv = getattr(st, attr), getattr(rt, attr)
            ok = abs(sv - rv) < 0.01
            ok_all &= ok
            print(f"  [{'PASS' if ok else 'FAIL'}] {label}: "
                  f"sardine={sv:.4f}  rasterio={rv:.4f}")

        # Bounds
        sb, rb = s.bounds, r.bounds
        for label, sv, rv in [('left', sb.left, rb.left),
                               ('bottom', sb.bottom, rb.bottom),
                               ('right', sb.right, rb.right),
                               ('top', sb.top, rb.top)]:
            ok = abs(sv - rv) < 0.01
            ok_all &= ok
            print(f"  [{'PASS' if ok else 'FAIL'}] {label}: "
                  f"sardine={sv:.2f}  rasterio={rv:.2f}")

        # Band data
        print()
        for bi in range(1, s.profile['count'] + 1):
            sd = s.read(bi)
            rd = r.read(bi)
            diff = np.abs(sd - rd)
            mx = diff.max()
            ok = mx < 1e-5
            ok_all &= ok
            print(f"  [{'PASS' if ok else 'FAIL'}] band {bi}: "
                  f"max_diff={mx:.2e}  "
                  f"sardine=[{sd.min():.3e},{sd.max():.3e}]  "
                  f"rasterio=[{rd.min():.3e},{rd.max():.3e}]")

    print()
    if ok_all:
        print("  ALL PASS — both TIFs are identical")
    else:
        print("  SOME TESTS FAILED")
    print("="*60)
    return ok_all


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Compare SARdine vs rasterio GeoTIFF')
    parser.add_argument('h5_path', nargs='?', help='Path to NISAR HDF5 file')
    parser.add_argument('--ml', type=int, default=16, help='Multilook factor (default 16)')
    parser.add_argument('--rows', type=int, default=None,
                        help='Max output rows (default: all)')
    parser.add_argument('--outdir', default='test/data', help='Output directory')
    args = parser.parse_args()

    # Find an H5 file
    if args.h5_path:
        h5 = args.h5_path
    else:
        candidates = [
            'test/data/NISAR_L2_PR_GCOV_013_155_D_091_2005_DHDH_A_20251226T231525_20251226T231556_P05006_N_F_J_001.h5',
            'test/data/NISAR_L2_PR_GCOV_013_120_D_075_2005_QPDH_A_20251224T125029_20251224T125103_P05006_N_F_J_001.h5',
        ]
        h5 = next((f for f in candidates if os.path.exists(f)), None)
        if not h5:
            print("No HDF5 file found. Pass path as argument.")
            sys.exit(1)

    os.makedirs(args.outdir, exist_ok=True)

    # Read metadata
    meta = read_nisar(h5)
    ml = args.ml
    ew, eh_full = meta['width'] // ml, meta['height'] // ml

    print(f"\nSource: {os.path.basename(h5)}")
    print(f"  EPSG:{meta['epsg']}  {meta['width']}x{meta['height']}  "
          f"spacing: {meta['x_spacing']}m x {meta['y_spacing']}m")
    print(f"  Pols: {meta['pols']}")
    print(f"  Multilook: {ml}x  ->  {ew} x {eh_full}")

    # Read bands
    bands, w, h = read_bands(meta, ml, max_rows=args.rows)

    # Pixel-edge bounds (same correction as main.jsx lines 817-822)
    sx, sy = meta['x_spacing'], meta['y_spacing']
    pixel_edge_bounds = [
        meta['bounds'][0] - sx/2,
        meta['bounds'][1] - sy/2,
        meta['bounds'][2] + sx/2,
        meta['bounds'][3] + sy/2,
    ]

    # If we used a row subset, adjust the bottom bound
    if h < eh_full:
        psy = (pixel_edge_bounds[3] - pixel_edge_bounds[1]) / eh_full
        pixel_edge_bounds[1] = pixel_edge_bounds[3] - h * psy

    epsg = meta['epsg']
    names = meta['pols']

    sardine_tif = os.path.join(args.outdir, 'sardine_output.tif')
    rasterio_tif = os.path.join(args.outdir, 'rasterio_output.tif')

    # Write both
    print(f"\nWriting SARdine-style: {sardine_tif}")
    sardine_write(sardine_tif, bands, names, w, h, pixel_edge_bounds, epsg)
    print(f"  {os.path.getsize(sardine_tif) / 1e6:.1f} MB")

    print(f"\nWriting rasterio:      {rasterio_tif}")
    rasterio_write(rasterio_tif, bands, names, w, h, pixel_edge_bounds, epsg)
    print(f"  {os.path.getsize(rasterio_tif) / 1e6:.1f} MB")

    # Compare
    passed = compare(sardine_tif, rasterio_tif)

    # Summary for the user
    print(f"\nOutput files to inspect in QGIS:")
    print(f"  {os.path.abspath(sardine_tif)}")
    print(f"  {os.path.abspath(rasterio_tif)}")
    print(f"\nBoth contain {len(names)} bands ({', '.join(names)}), "
          f"Float32, {w}x{h} pixels, EPSG:{epsg}")
    print(f"They should overlay perfectly and show identical values.\n")

    return 0 if passed else 1


if __name__ == '__main__':
    sys.exit(main())
