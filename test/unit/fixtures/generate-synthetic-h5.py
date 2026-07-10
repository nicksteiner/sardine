#!/usr/bin/env python3
"""Generate the synthetic chunked HDF5 fixtures used by h5chunk-synthetic.test.mjs.

Creates two tiny (<100 KB) HDF5 files that exercise the h5chunk code paths:
  - group traversal (/science/grids/data)
  - chunked layout with a v1 B-tree chunk index
  - deflate (gzip) + shuffle filter pipeline
  - float32 dtype

synthetic-chunked.h5 (cloud-optimized layout, matches real NISAR products):
  libver='earliest' + fs_strategy='page' → superblock v2+, paged aggregation.

synthetic-chunked-v0.h5 (default h5py settings — h5py.File(path, 'w')):
  superblock v0, root group located via the root symbol-table entry
  (linkNameOffset → objectHeaderAddress → cacheType → scratch). This is the
  layout casual users produce; regression fixture for the W013 parseSuperblock
  fix (the v0/v1 path previously misread linkNameOffset as rootGroupAddress).

Pixel values are deterministic: data[r, c] = r * 100 + c (exactly representable
in float32 for this array size), so the JS test can hand-compute expectations.

Run once (fixtures are committed):
  python3 test/unit/fixtures/generate-synthetic-h5.py
"""
import os

import h5py
import numpy as np

ROWS, COLS = 64, 48
CHUNK = (16, 16)

fixtures_dir = os.path.dirname(os.path.abspath(__file__))

r = np.arange(ROWS, dtype=np.float32).reshape(-1, 1)
c = np.arange(COLS, dtype=np.float32).reshape(1, -1)
data = r * 100.0 + c  # data[r, c] = r*100 + c


def write_fixture(filename, **file_kwargs):
    out_path = os.path.join(fixtures_dir, filename)
    with h5py.File(out_path, "w", **file_kwargs) as f:
        grp = f.create_group("science/grids")
        grp.create_dataset(
            "data",
            data=data,
            chunks=CHUNK,
            compression="gzip",
            compression_opts=4,
            shuffle=True,
        )
    size = os.path.getsize(out_path)
    print(f"wrote {out_path} ({size} bytes)")
    assert size < 100_000, "fixture must stay under 100 KB"


# libver='earliest' keeps v1 object headers + v1 B-tree chunk index;
# fs_strategy='page' bumps the superblock to v2+ (cloud-optimized layout),
# matching real NISAR products.
write_fixture("synthetic-chunked.h5", libver="earliest", fs_strategy="page", fs_page_size=4096)

# Default h5py settings → superblock v0 (the most common casual output).
write_fixture("synthetic-chunked-v0.h5")
