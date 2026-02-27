#!/usr/bin/env python3
"""
Benchmark 1: SNAP GPT Primitive Coverage Matrix

Maps ESA SNAP Toolbox GPT operators to SARdine primitives.
Produces CSV table and summary statistics for paper.
"""

import csv
import json
import os
import sys

# SNAP GPT operators relevant to post-SLC SAR visualization and analysis.
# Source: ESA SNAP documentation, SNAP GPT operator list.
# We exclude pre-SLC operators (orbit correction, azimuth focusing, etc.)
# and InSAR-specific operators (phase unwrapping, coherence estimation via FFT).
SNAP_OPERATORS = [
    # --- Radiometric ---
    {
        "operator": "Calibration",
        "category": "Radiometric",
        "description": "Apply radiometric calibration (sigma0, beta0, gamma0)",
        "sardine_primitive": "mul (calibration LUT × amplitude²)",
        "sardine_location": "nisar-loader.js (calibration applied at load)",
        "status": "equivalent",
    },
    {
        "operator": "LinearToFromdB",
        "category": "Radiometric",
        "description": "Convert between linear power and decibel scale",
        "sardine_primitive": "10 * log10(x) in GLSL shader",
        "sardine_location": "shaders.js:182, SARGPULayer.js:70",
        "status": "exact",
    },
    {
        "operator": "BandMaths",
        "category": "Radiometric",
        "description": "Arbitrary per-pixel arithmetic expressions",
        "sardine_primitive": "add, mul, div, sqrt, log, exp, pow, abs, min, max",
        "sardine_location": "shaders.js (GPU), stretch.js + colormap.js (CPU)",
        "status": "equivalent",
    },
    {
        "operator": "BandMerge",
        "category": "Radiometric",
        "description": "Merge multiple bands into one product",
        "sardine_primitive": "Multi-texture RGB composite",
        "sardine_location": "SARGPULayer.js (3-texture mode), sar-composites.js",
        "status": "equivalent",
    },
    {
        "operator": "BandSelect",
        "category": "Radiometric",
        "description": "Select specific bands from product",
        "sardine_primitive": "Dataset/polarization selector in UI",
        "sardine_location": "nisar-loader.js (frequency/pol selection)",
        "status": "equivalent",
    },
    # --- Filtering ---
    {
        "operator": "Multilook",
        "category": "SAR Filtering",
        "description": "Spatial averaging to reduce speckle (range × azimuth looks)",
        "sardine_primitive": "Box-filter ml×ml averaging on raw power",
        "sardine_location": "nisar-loader.js:1108-1137 (4 implementations)",
        "status": "exact",
    },
    {
        "operator": "Speckle-Filter (Boxcar)",
        "category": "SAR Filtering",
        "description": "NxN mean filter for speckle reduction",
        "sardine_primitive": "3×3 spatial smooth in export path",
        "sardine_location": "nisar-loader.js (export smooth)",
        "status": "partial",
        "note": "Only 3×3 mean; no Lee, Frost, or Gamma-MAP",
    },
    {
        "operator": "Speckle-Filter (Lee)",
        "category": "SAR Filtering",
        "description": "Adaptive Lee speckle filter",
        "sardine_primitive": None,
        "sardine_location": None,
        "status": "not-implemented",
        "note": "Requires local statistics computation (mean, variance)",
    },
    {
        "operator": "Speckle-Filter (Refined Lee)",
        "category": "SAR Filtering",
        "description": "Edge-preserving Lee filter with directional windows",
        "sardine_primitive": None,
        "sardine_location": None,
        "status": "not-implemented",
        "note": "Requires directional window selection + local stats",
    },
    {
        "operator": "Speckle-Filter (Frost)",
        "category": "SAR Filtering",
        "description": "Exponentially weighted speckle filter",
        "sardine_primitive": None,
        "sardine_location": None,
        "status": "not-implemented",
    },
    {
        "operator": "Speckle-Filter (Gamma-MAP)",
        "category": "SAR Filtering",
        "description": "Gamma distribution MAP speckle filter",
        "sardine_primitive": None,
        "sardine_location": None,
        "status": "not-implemented",
    },
    # --- Polarimetry ---
    {
        "operator": "Polarimetric-Decomposition (Freeman-Durden)",
        "category": "Polarimetry",
        "description": "3-component power decomposition (surface, double-bounce, volume)",
        "sardine_primitive": "Freeman-Durden from C3 matrix elements",
        "sardine_location": "sar-composites.js:32-116",
        "status": "exact",
    },
    {
        "operator": "Polarimetric-Decomposition (Pauli)",
        "category": "Polarimetry",
        "description": "Pauli RGB: |HH-VV|, |HV|, |HH+VV|",
        "sardine_primitive": "Pauli from power (abs-diff, add, div)",
        "sardine_location": "sar-composites.js:138-165",
        "status": "equivalent",
        "note": "Approximate from power products (GCOV), not full complex Pauli",
    },
    {
        "operator": "Polarimetric-Decomposition (H-Alpha)",
        "category": "Polarimetry",
        "description": "Entropy-Alpha decomposition from coherency matrix",
        "sardine_primitive": None,
        "sardine_location": "matrix.js (scaffolded, not implemented)",
        "status": "not-implemented",
        "note": "Requires 3×3 eigendecomposition",
    },
    {
        "operator": "Polarimetric-Speckle-Filter",
        "category": "Polarimetry",
        "description": "Multi-channel speckle filter preserving polarimetric info",
        "sardine_primitive": None,
        "sardine_location": None,
        "status": "out-of-scope",
        "note": "Advanced filtering is pre-processing; GCOV products are already multi-looked",
    },
    {
        "operator": "Polarimetric-Matrix (C3/T3)",
        "category": "Polarimetry",
        "description": "Compute covariance/coherency matrix from SLC",
        "sardine_primitive": "Reads pre-computed C3 elements from GCOV",
        "sardine_location": "nisar-loader.js (GCOV products store C3)",
        "status": "equivalent",
        "note": "GCOV already provides matrix elements; no SLC→C3 computation needed",
    },
    # --- Statistics / Visualization ---
    {
        "operator": "StatisticsOp",
        "category": "Statistics",
        "description": "Compute band statistics (min, max, mean, std, histogram)",
        "sardine_primitive": "min, max, mean, median, stddev, histogram, percentiles",
        "sardine_location": "stats.js:12-278",
        "status": "exact",
    },
    {
        "operator": "HistogramEqualization",
        "category": "Statistics",
        "description": "Histogram equalization for contrast enhancement",
        "sardine_primitive": "Percentile-based auto-contrast (2nd/98th)",
        "sardine_location": "stats.js:225-278",
        "status": "equivalent",
        "note": "Percentile stretch, not full CDF equalization",
    },
    {
        "operator": "ContrastStretch",
        "category": "Visualization",
        "description": "Linear/sqrt/log contrast stretch",
        "sardine_primitive": "linear, sqrt, gamma, sigmoid stretch modes",
        "sardine_location": "stretch.js, shaders.js:192-205",
        "status": "exact",
        "note": "SARdine has 4 modes vs SNAP's 3; sigmoid is additional",
    },
    {
        "operator": "ColorManipulation",
        "category": "Visualization",
        "description": "Apply color table / LUT to single-band image",
        "sardine_primitive": "9 colormaps (grayscale, viridis, inferno, plasma, phase, sardine, flood, diverging, polarimetric)",
        "sardine_location": "shaders.js:53-173, colormap.js",
        "status": "exact",
    },
    {
        "operator": "RGB-ImageProfile",
        "category": "Visualization",
        "description": "Create RGB composite from 3 bands",
        "sardine_primitive": "RGB composite (6 presets: Pauli, dual-pol-h/v, quad-pol, Freeman-Durden)",
        "sardine_location": "sar-composites.js, SARGPULayer.js (3-texture mode)",
        "status": "exact",
    },
    {
        "operator": "CreateStack",
        "category": "Data Management",
        "description": "Stack multiple products for comparison",
        "sardine_primitive": "Multi-dataset loading in viewer",
        "sardine_location": "main.jsx (multi-file comparison)",
        "status": "equivalent",
    },
    # --- Geometric ---
    {
        "operator": "Terrain-Correction (Range-Doppler)",
        "category": "Geometric",
        "description": "Geocode SAR image using DEM and orbit",
        "sardine_primitive": None,
        "sardine_location": None,
        "status": "out-of-scope",
        "note": "GCOV products are pre-geocoded; terrain correction is pre-processing",
    },
    {
        "operator": "Terrain-Correction (SAR-Simulation)",
        "category": "Geometric",
        "description": "Simulation-based terrain correction",
        "sardine_primitive": None,
        "sardine_location": None,
        "status": "out-of-scope",
        "note": "Pre-geocoded input assumed; terrain correction is pre-processing",
    },
    {
        "operator": "Ellipsoid-Correction",
        "category": "Geometric",
        "description": "Simple geocoding without DEM",
        "sardine_primitive": "Coordinate array extraction from HDF5",
        "sardine_location": "nisar-loader.js (lat/lon from HDF5 datasets)",
        "status": "equivalent",
        "note": "GCOV provides geographic coordinates directly",
    },
    {
        "operator": "Reproject",
        "category": "Geometric",
        "description": "Reproject to different CRS",
        "sardine_primitive": None,
        "sardine_location": None,
        "status": "out-of-scope",
        "note": "Viewer uses native EPSG:4326; reprojection is pre-processing",
    },
    {
        "operator": "Subset",
        "category": "Data Management",
        "description": "Extract spatial or band subset",
        "sardine_primitive": "Viewport-driven chunk selection (spatial subset)",
        "sardine_location": "h5chunk.js (readRegion), nisar-loader.js (getTile)",
        "status": "exact",
        "note": "Viewport IS the spatial subset; only visible chunks are read",
    },
    {
        "operator": "Resample",
        "category": "Geometric",
        "description": "Resample to different pixel spacing",
        "sardine_primitive": "Bilinear interpolation in mosaic tiles + multilook downsampling",
        "sardine_location": "nisar-loader.js (buildMosaicTile, multilook)",
        "status": "equivalent",
    },
    # --- I/O ---
    {
        "operator": "Read",
        "category": "I/O",
        "description": "Read product from file",
        "sardine_primitive": "h5chunk (HDF5), geotiff.js (COG), File API",
        "sardine_location": "h5chunk.js, cog-loader.js",
        "status": "exact",
    },
    {
        "operator": "Write",
        "category": "I/O",
        "description": "Write product to file",
        "sardine_primitive": "GeoTIFF export (Float32 + RGBA + RGB)",
        "sardine_location": "geotiff-writer.js",
        "status": "exact",
    },
    # --- Masking ---
    {
        "operator": "Land-Sea-Mask",
        "category": "Masking",
        "description": "Create land/sea mask from coastline data",
        "sardine_primitive": "Overture Maps vector overlay (coastline/land polygons)",
        "sardine_location": "OvertureLayer.js, overture-loader.js",
        "status": "equivalent",
        "note": "Uses PMTiles vector overlay for land/water boundaries",
    },
    {
        "operator": "ValidPixelExpression",
        "category": "Masking",
        "description": "Mask pixels based on expression",
        "sardine_primitive": "NaN/zero masking in shader + NISAR mask texture",
        "sardine_location": "shaders.js:232, SARGPULayer.js (mask texture)",
        "status": "equivalent",
    },
    # --- InSAR (FFT-dependent) ---
    {
        "operator": "Interferogram",
        "category": "InSAR",
        "description": "Form interferogram from coregistered SLC pair",
        "sardine_primitive": None,
        "sardine_location": None,
        "status": "fft-dependent",
        "note": "Requires complex multiplication of coregistered SLCs",
    },
    {
        "operator": "GoldsteinPhaseFiltering",
        "category": "InSAR",
        "description": "Adaptive phase filter in frequency domain",
        "sardine_primitive": None,
        "sardine_location": None,
        "status": "fft-dependent",
    },
    {
        "operator": "PhaseUnwrapping",
        "category": "InSAR",
        "description": "2D phase unwrapping (SNAPHU integration)",
        "sardine_primitive": None,
        "sardine_location": None,
        "status": "fft-dependent",
    },
    {
        "operator": "Coherence",
        "category": "InSAR",
        "description": "Estimate interferometric coherence",
        "sardine_primitive": None,
        "sardine_location": None,
        "status": "fft-dependent",
        "note": "Requires complex cross-correlation in sliding window",
    },
    {
        "operator": "Coregistration",
        "category": "InSAR",
        "description": "Sub-pixel coregistration of SLC pairs",
        "sardine_primitive": None,
        "sardine_location": None,
        "status": "fft-dependent",
    },
]


def compute_coverage(operators):
    """Compute coverage statistics by category and status."""
    stats = {
        "total": len(operators),
        "by_status": {},
        "by_category": {},
    }
    for op in operators:
        s = op["status"]
        stats["by_status"][s] = stats["by_status"].get(s, 0) + 1

        cat = op["category"]
        if cat not in stats["by_category"]:
            stats["by_category"][cat] = {"total": 0, "covered": 0}
        stats["by_category"][cat]["total"] += 1
        if s in ("exact", "equivalent", "partial"):
            stats["by_category"][cat]["covered"] += 1

    # Post-SLC visualization-relevant = exclude InSAR (FFT-dependent) and out-of-scope
    post_slc = [o for o in operators if o["status"] not in ("fft-dependent", "out-of-scope")]
    covered = [o for o in post_slc if o["status"] in ("exact", "equivalent", "partial")]
    stats["post_slc_total"] = len(post_slc)
    stats["post_slc_covered"] = len(covered)
    stats["post_slc_pct"] = round(100 * len(covered) / len(post_slc), 1) if post_slc else 0
    stats["out_of_scope"] = len([o for o in operators if o["status"] == "out-of-scope"])

    return stats


def write_csv(operators, path):
    """Write coverage matrix to CSV."""
    fields = ["operator", "category", "description", "status", "sardine_primitive", "sardine_location", "note"]
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for op in operators:
            row = {k: op.get(k, "") or "" for k in fields}
            writer.writerow(row)


def write_figure(operators, stats, path):
    """Generate category coverage bar chart."""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        import numpy as np
    except ImportError:
        print("  [SKIP] matplotlib not available for figure generation")
        return

    cats = sorted(stats["by_category"].keys())
    covered = [stats["by_category"][c]["covered"] for c in cats]
    total = [stats["by_category"][c]["total"] for c in cats]
    not_covered = [t - c for t, c in zip(total, covered)]

    fig, ax = plt.subplots(figsize=(10, 5))
    x = np.arange(len(cats))
    width = 0.6

    ax.bar(x, covered, width, label="Covered (exact/equivalent/partial)", color="#4ec9d4")
    ax.bar(x, not_covered, width, bottom=covered, label="Not covered / FFT-dependent", color="#2a2a3a")

    ax.set_ylabel("Number of Operators")
    ax.set_title("SNAP GPT Operator Coverage by SARdine Primitives")
    ax.set_xticks(x)
    ax.set_xticklabels(cats, rotation=35, ha="right", fontsize=8)
    ax.legend()
    ax.set_ylim(0, max(total) + 1)

    # Add percentage labels
    for i, (c, t) in enumerate(zip(covered, total)):
        pct = round(100 * c / t) if t > 0 else 0
        ax.text(i, t + 0.2, f"{pct}%", ha="center", va="bottom", fontsize=8, fontweight="bold")

    plt.tight_layout()
    plt.savefig(path, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"  Figure saved: {path}")


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    results_dir = os.path.join(script_dir, "results")
    os.makedirs(results_dir, exist_ok=True)

    print("=" * 60)
    print("Benchmark 1: SNAP GPT Primitive Coverage Matrix")
    print("=" * 60)

    # Write CSV
    csv_path = os.path.join(results_dir, "snap_coverage.csv")
    write_csv(SNAP_OPERATORS, csv_path)
    print(f"  CSV written: {csv_path}")

    # Compute stats
    stats = compute_coverage(SNAP_OPERATORS)

    print(f"\n  Total SNAP operators analyzed: {stats['total']}")
    print(f"  Post-SLC operators: {stats['post_slc_total']}")
    print(f"  Covered by SARdine: {stats['post_slc_covered']} ({stats['post_slc_pct']}%)")
    print(f"\n  By status:")
    for status, count in sorted(stats["by_status"].items()):
        print(f"    {status}: {count}")
    print(f"\n  By category:")
    for cat, info in sorted(stats["by_category"].items()):
        pct = round(100 * info["covered"] / info["total"]) if info["total"] > 0 else 0
        print(f"    {cat}: {info['covered']}/{info['total']} ({pct}%)")

    # Check success criterion
    if stats["post_slc_pct"] >= 80:
        print(f"\n  PASS: {stats['post_slc_pct']}% >= 80% coverage target")
    else:
        print(f"\n  FAIL: {stats['post_slc_pct']}% < 80% coverage target")

    # Write figure
    fig_path = os.path.join(results_dir, "fig_primitive_coverage.pdf")
    write_figure(SNAP_OPERATORS, stats, fig_path)

    # Write summary
    summary = {
        "benchmark": "1_primitive_coverage",
        "post_slc_coverage_pct": stats["post_slc_pct"],
        "post_slc_total": stats["post_slc_total"],
        "post_slc_covered": stats["post_slc_covered"],
        "by_status": stats["by_status"],
        "pass": stats["post_slc_pct"] >= 80,
    }
    summary_path = os.path.join(results_dir, "bench1_summary.json")
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)
    print(f"  Summary written: {summary_path}")

    return 0 if stats["post_slc_pct"] >= 80 else 1


if __name__ == "__main__":
    sys.exit(main())
