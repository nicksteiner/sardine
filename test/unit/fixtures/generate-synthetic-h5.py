#!/usr/bin/env python3
"""Generate the synthetic chunked HDF5 fixture used by h5chunk-synthetic.test.mjs.

Creates a tiny (<100 KB) HDF5 file that exercises the h5chunk code paths:
  - group traversal (/science/grids/data)
  - chunked layout with a v1 B-tree chunk index (libver='earliest')
  - deflate (gzip) + shuffle filter pipeline
  - float32 dtype
  - paged file-space aggregation (fs_strategy='page') → superblock v2+.
    h5chunk only parses superblock v2/v3 root-group addresses correctly
    (the v0 path misreads the root symbol-table entry); real cloud-optimized
    NISAR products are paged, so the fixture matches that layout.

Pixel values are deterministic: data[r, c] = r * 100 + c (exactly representable
in float32 for this array size), so the JS test can hand-compute expectations.

Run once (fixture is committed):
  python3 test/unit/fixtures/generate-synthetic-h5.py
"""
import os

import h5py
import numpy as np

ROWS, COLS = 64, 48
CHUNK = (16, 16)

out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "synthetic-chunked.h5")

r = np.arange(ROWS, dtype=np.float32).reshape(-1, 1)
c = np.arange(COLS, dtype=np.float32).reshape(1, -1)
data = r * 100.0 + c  # data[r, c] = r*100 + c

# libver='earliest' keeps v1 object headers + v1 B-tree chunk index;
# fs_strategy='page' bumps the superblock to v2+ (cloud-optimized layout),
# which is the combination h5chunk parses for NISAR products.
with h5py.File(out_path, "w", libver="earliest", fs_strategy="page", fs_page_size=4096) as f:
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
