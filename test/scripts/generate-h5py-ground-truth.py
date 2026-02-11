#!/usr/bin/env python3
"""
Generate h5py ground truth for h5chunk validation

Extracts structure, data samples, and metadata from an HDF5 file using h5py.
Output JSON can be compared against h5chunk results.

Usage:
    python test/scripts/generate-h5py-ground-truth.py <h5-file> > truth.json

Requirements:
    pip install h5py numpy
"""

import sys
import json
import h5py
import numpy as np
from pathlib import Path


def serialize_numpy(obj):
    """Convert numpy types to JSON-serializable types"""
    if isinstance(obj, np.integer):
        return int(obj)
    elif isinstance(obj, np.floating):
        return float(obj)
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    elif isinstance(obj, bytes):
        return obj.decode('utf-8', errors='ignore')
    return obj


def walk_datasets(group, path='/', datasets=None):
    """Recursively walk HDF5 groups and collect datasets"""
    if datasets is None:
        datasets = []

    for key in group.keys():
        item_path = f"{path}{key}" if path.endswith('/') else f"{path}/{key}"
        item = group[key]

        if isinstance(item, h5py.Dataset):
            dtype_str = str(item.dtype)
            # Simplify dtype string
            if dtype_str.startswith('<f'):
                dtype_str = f'<f{item.dtype.itemsize}'
            elif dtype_str.startswith('>f'):
                dtype_str = f'>f{item.dtype.itemsize}'

            dataset_info = {
                'path': item_path,
                'name': key,
                'shape': list(item.shape),
                'dtype': dtype_str,
                'size': int(item.size),
            }

            # Check if chunked
            if item.chunks:
                dataset_info['chunks'] = list(item.chunks)
                dataset_info['layout'] = 'chunked'
            else:
                dataset_info['layout'] = 'contiguous'

            # Get compression info
            if item.compression:
                dataset_info['compression'] = item.compression
                if item.compression_opts:
                    dataset_info['compression_opts'] = item.compression_opts

            # Get fillvalue
            if item.fillvalue is not None:
                dataset_info['fillvalue'] = serialize_numpy(item.fillvalue)

            datasets.append(dataset_info)

        elif isinstance(item, h5py.Group):
            walk_datasets(item, item_path, datasets)

    return datasets


def get_chunk_info(dataset):
    """Extract chunk layout information"""
    if not dataset.chunks:
        return None

    chunks = []
    # For chunked datasets, h5py doesn't expose chunk addresses directly
    # We can only report the logical chunk structure
    shape = dataset.shape
    chunk_dims = dataset.chunks

    if len(shape) == 2:
        rows, cols = shape
        chunk_rows, chunk_cols = chunk_dims
        n_row_chunks = (rows + chunk_rows - 1) // chunk_rows
        n_col_chunks = (cols + chunk_cols - 1) // chunk_cols

        return {
            'dims': list(chunk_dims),
            'count': [n_row_chunks, n_col_chunks],
            'total_chunks': n_row_chunks * n_col_chunks,
        }

    return {'dims': list(chunk_dims)}


def sample_data(dataset, max_samples=100):
    """Sample data from dataset for validation"""
    if dataset.size == 0:
        return []

    # Read first N×N pixels
    shape = dataset.shape

    if len(shape) == 1:
        n = min(max_samples, shape[0])
        return dataset[:n].tolist()
    elif len(shape) == 2:
        n = int(np.sqrt(max_samples))
        rows = min(n, shape[0])
        cols = min(n, shape[1])
        return dataset[:rows, :cols].flatten().tolist()
    else:
        # Higher dimensions, just sample first slice
        return dataset.flat[:max_samples].tolist()


def main():
    if len(sys.argv) < 2:
        print("Usage: python generate-h5py-ground-truth.py <h5-file>", file=sys.stderr)
        sys.exit(1)

    h5_path = Path(sys.argv[1])

    if not h5_path.exists():
        print(f"Error: File not found: {h5_path}", file=sys.stderr)
        sys.exit(1)

    print(f"# Reading: {h5_path}", file=sys.stderr)
    print(f"# Size: {h5_path.stat().st_size / 1e6:.1f} MB", file=sys.stderr)

    with h5py.File(h5_path, 'r') as f:
        # Collect all datasets
        print("# Discovering datasets...", file=sys.stderr)
        datasets = walk_datasets(f)
        print(f"# Found {len(datasets)} datasets", file=sys.stderr)

        # Find GCOV datasets for data sampling
        gcov_datasets = [ds for ds in datasets if '/GCOV/' in ds['path'] and ds['path'].endswith(('HHHH', 'HVHV', 'VVVV'))]

        # Sample data from first GCOV dataset
        print("# Sampling data...", file=sys.stderr)
        values = {}
        if gcov_datasets:
            for ds_info in gcov_datasets[:3]:  # Sample up to 3 datasets
                ds = f[ds_info['path']]
                key = ds_info['path'].split('/')[-1]  # e.g., "HHHH"
                values[key] = sample_data(ds, max_samples=100)

        # Get chunk info for GCOV datasets
        print("# Analyzing chunks...", file=sys.stderr)
        chunks = {}
        for ds_info in gcov_datasets:
            ds = f[ds_info['path']]
            key = ds_info['path'].split('/')[-1]
            chunk_info = get_chunk_info(ds)
            if chunk_info:
                chunks[key] = chunk_info

        # Get coordinates
        print("# Reading coordinates...", file=sys.stderr)
        coordinates = {}
        xcoord_paths = [ds['path'] for ds in datasets if ds['path'].endswith('/xCoordinates')]
        ycoord_paths = [ds['path'] for ds in datasets if ds['path'].endswith('/yCoordinates')]

        if xcoord_paths:
            xcoords = f[xcoord_paths[0]]
            coordinates['x'] = xcoords[:min(1000, xcoords.shape[0])].tolist()

        if ycoord_paths:
            ycoords = f[ycoord_paths[0]]
            coordinates['y'] = ycoords[:min(1000, ycoords.shape[0])].tolist()

        # Get identification metadata
        print("# Reading metadata...", file=sys.stderr)
        metadata = {}
        ident_paths = [ds for ds in datasets if '/identification/' in ds['path']]

        for ds_info in ident_paths[:10]:  # Sample first 10 metadata fields
            try:
                ds = f[ds_info['path']]
                key = ds_info['name']
                if ds.size == 1:
                    value = serialize_numpy(ds[()])
                    metadata[key] = value
            except Exception as e:
                print(f"# Warning: Could not read {ds_info['path']}: {e}", file=sys.stderr)

        # Build output
        output = {
            'file': str(h5_path),
            'file_size': h5_path.stat().st_size,
            'h5py_version': h5py.version.version,
            'datasets': datasets,
            'dataset_count': len(datasets),
            'values': values,
            'chunks': chunks,
            'coordinates': coordinates,
            'metadata': metadata,
        }

        # Output JSON
        print("# Writing JSON...", file=sys.stderr)
        json.dump(output, sys.stdout, indent=2, default=serialize_numpy)
        print("", file=sys.stderr)
        print(f"# Done! Generated ground truth with {len(datasets)} datasets", file=sys.stderr)


if __name__ == '__main__':
    main()
