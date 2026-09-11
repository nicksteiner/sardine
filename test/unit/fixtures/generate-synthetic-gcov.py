#!/usr/bin/env python3
"""Generate the synthetic NISAR GCOV fixture used by the W030 load-UX tests.

`synthetic-gcov.h5` is a spec-shaped miniature of an L2 GCOV product — the
same group/dataset paths `nisarPaths()` builds, so `loadNISARGCOV()` runs its
real detection, metadata and chunk-streaming code against it without a
multi-gigabyte download:

  /science/LSAR/identification/{listOfFrequencies,productType,...}
  /science/LSAR/GCOV/grids/frequencyA/{HHHH,mask,projection,
                                       xCoordinates,yCoordinates,
                                       listOfCovarianceTerms}

HHHH is 256x256 float32 in 32x32 chunks (64 chunks) with gzip+shuffle, so a
streaming load issues many chunk reads — enough for a progress test to see
real per-chunk reporting rather than a single jump.

Cloud-optimized layout (libver='earliest' + fs_strategy='page'), matching the
committed synthetic-chunked.h5 fixture and real NISAR products.

Run once (the fixture is committed):
  python3 test/unit/fixtures/generate-synthetic-gcov.py
"""
import os

import h5py
import numpy as np

ROWS, COLS = 256, 256
CHUNK = (32, 32)
EPSG = 32610  # UTM 10N — a projected grid, as real GCOV granules use
X0, Y0, SPACING = 500000.0, 4200000.0, 20.0

fixtures_dir = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(fixtures_dir, 'synthetic-gcov.h5')

# Deterministic, strictly positive backscatter so dB conversion is well defined.
r = np.arange(ROWS, dtype=np.float32).reshape(-1, 1)
c = np.arange(COLS, dtype=np.float32).reshape(1, -1)
gamma0 = (0.01 + 0.001 * (r + c)).astype(np.float32)

if os.path.exists(path):
    os.remove(path)

with h5py.File(path, 'w', libver='earliest', fs_strategy='page',
               fs_page_size=8192) as f:
    ident = f.create_group('/science/LSAR/identification')
    ident.create_dataset('listOfFrequencies', data=np.array([b'A']))
    ident.create_dataset('productType', data=np.bytes_('GCOV'))
    ident.create_dataset('missionId', data=np.bytes_('NISAR'))
    ident.create_dataset('absoluteOrbitNumber', data=np.int32(1234))
    ident.create_dataset('trackNumber', data=np.int32(147))
    ident.create_dataset('frameNumber', data=np.int32(175))
    ident.create_dataset('lookDirection', data=np.bytes_('Right'))
    ident.create_dataset('orbitPassDirection', data=np.bytes_('Ascending'))
    ident.create_dataset('radarBand', data=np.bytes_('L'))
    ident.create_dataset('productLevel', data=np.bytes_('L2'))
    ident.create_dataset('isGeocoded', data=np.int8(1))

    grid = f.create_group('/science/LSAR/GCOV/grids/frequencyA')
    grid.create_dataset('listOfCovarianceTerms', data=np.array([b'HHHH']))
    grid.create_dataset('listOfPolarizations', data=np.array([b'HH']))
    proj = grid.create_dataset('projection', data=np.uint32(EPSG))
    proj.attrs['epsg_code'] = np.uint32(EPSG)
    grid.create_dataset('xCoordinates',
                        data=X0 + SPACING * np.arange(COLS, dtype=np.float64))
    grid.create_dataset('yCoordinates',
                        data=Y0 - SPACING * np.arange(ROWS, dtype=np.float64))
    grid.create_dataset('xCoordinateSpacing', data=np.float64(SPACING))
    grid.create_dataset('yCoordinateSpacing', data=np.float64(-SPACING))

    ds = grid.create_dataset('HHHH', data=gamma0, chunks=CHUNK,
                             compression='gzip', compression_opts=4,
                             shuffle=True)
    ds.attrs['_FillValue'] = np.float32(np.nan)
    ds.attrs['mean_value'] = np.float32(gamma0.mean())
    ds.attrs['sample_stddev'] = np.float32(gamma0.std())
    ds.attrs['min_value'] = np.float32(gamma0.min())
    ds.attrs['max_value'] = np.float32(gamma0.max())

print(f'wrote {path} ({os.path.getsize(path)} bytes, '
      f'{ROWS // CHUNK[0] * (COLS // CHUNK[1])} chunks)')
