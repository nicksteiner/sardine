#!/usr/bin/env python3
"""Benchmark 1: SNAP GPT Primitive Coverage Matrix"""
import csv, json, os, sys

SNAP_OPERATORS = [
    {"operator": "Calibration", "category": "Radiometric", "description": "Radiometric calibration", "sardine_primitive": "mul (cal LUT x amplitude)", "sardine_location": "nisar-loader.js", "status": "equivalent"},
    {"operator": "LinearToFromdB", "category": "Radiometric", "description": "Linear to/from dB", "sardine_primitive": "10*log10(x) in GLSL", "sardine_location": "shaders.js:182", "status": "exact"},
    {"operator": "BandMaths", "category": "Radiometric", "description": "Per-pixel arithmetic", "sardine_primitive": "add,mul,div,sqrt,log,exp,pow,abs,min,max", "sardine_location": "shaders.js, stretch.js", "status": "equivalent"},
    {"operator": "BandMerge", "category": "Radiometric", "description": "Merge bands", "sardine_primitive": "Multi-texture RGB composite", "sardine_location": "SARGPULayer.js, sar-composites.js", "status": "equivalent"},
    {"operator": "BandSelect", "category": "Radiometric", "description": "Select bands", "sardine_primitive": "Dataset/pol selector", "sardine_location": "nisar-loader.js", "status": "equivalent"},
    {"operator": "Multilook", "category": "SAR Filtering", "description": "Spatial averaging", "sardine_primitive": "Box-filter ml*ml", "sardine_location": "nisar-loader.js:1108-1137", "status": "exact"},
    {"operator": "Speckle-Filter (Boxcar)", "category": "SAR Filtering", "description": "NxN mean filter", "sardine_primitive": "3x3 spatial smooth", "sardine_location": "nisar-loader.js", "status": "partial"},
    {"operator": "Speckle-Filter (Lee)", "category": "SAR Filtering", "description": "Lee filter", "sardine_primitive": None, "sardine_location": None, "status": "not-implemented"},
    {"operator": "Speckle-Filter (Refined Lee)", "category": "SAR Filtering", "description": "Refined Lee filter", "sardine_primitive": None, "sardine_location": None, "status": "not-implemented"},
    {"operator": "Speckle-Filter (Frost)", "category": "SAR Filtering", "description": "Frost filter", "sardine_primitive": None, "sardine_location": None, "status": "not-implemented"},
    {"operator": "Speckle-Filter (Gamma-MAP)", "category": "SAR Filtering", "description": "Gamma-MAP filter", "sardine_primitive": None, "sardine_location": None, "status": "not-implemented"},
    {"operator": "Polarimetric-Decomposition (Freeman-Durden)", "category": "Polarimetry", "description": "3-component decomposition", "sardine_primitive": "Freeman-Durden from C3", "sardine_location": "sar-composites.js:32-116", "status": "exact"},
    {"operator": "Polarimetric-Decomposition (Pauli)", "category": "Polarimetry", "description": "Pauli RGB", "sardine_primitive": "Pauli from power", "sardine_location": "sar-composites.js:138-165", "status": "equivalent"},
    {"operator": "Polarimetric-Decomposition (H-Alpha)", "category": "Polarimetry", "description": "H-Alpha decomposition", "sardine_primitive": None, "sardine_location": "matrix.js (scaffolded)", "status": "not-implemented"},
    {"operator": "Polarimetric-Speckle-Filter", "category": "Polarimetry", "description": "Pol speckle filter", "sardine_primitive": None, "sardine_location": None, "status": "out-of-scope", "note": "GCOV products are already multi-looked"},
    {"operator": "Polarimetric-Matrix (C3/T3)", "category": "Polarimetry", "description": "Compute C3/T3 matrix", "sardine_primitive": "Reads pre-computed C3 from GCOV", "sardine_location": "nisar-loader.js", "status": "equivalent"},
    {"operator": "StatisticsOp", "category": "Statistics", "description": "Band statistics", "sardine_primitive": "min,max,mean,median,std,histogram,percentiles", "sardine_location": "stats.js:12-278", "status": "exact"},
    {"operator": "HistogramEqualization", "category": "Statistics", "description": "Histogram equalization", "sardine_primitive": "Percentile auto-contrast (2nd/98th)", "sardine_location": "stats.js:225-278", "status": "equivalent"},
    {"operator": "ContrastStretch", "category": "Visualization", "description": "Contrast stretch", "sardine_primitive": "linear,sqrt,gamma,sigmoid", "sardine_location": "stretch.js, shaders.js:192-205", "status": "exact"},
    {"operator": "ColorManipulation", "category": "Visualization", "description": "Colormap/LUT", "sardine_primitive": "9 colormaps", "sardine_location": "shaders.js:53-173, colormap.js", "status": "exact"},
    {"operator": "RGB-ImageProfile", "category": "Visualization", "description": "RGB composite", "sardine_primitive": "6 RGB presets", "sardine_location": "sar-composites.js, SARGPULayer.js", "status": "exact"},
    {"operator": "CreateStack", "category": "Data Management", "description": "Stack products", "sardine_primitive": "Multi-dataset loading", "sardine_location": "main.jsx", "status": "equivalent"},
    {"operator": "Terrain-Correction (Range-Doppler)", "category": "Geometric", "description": "Geocode with DEM", "sardine_primitive": None, "sardine_location": None, "status": "out-of-scope"},
    {"operator": "Terrain-Correction (SAR-Simulation)", "category": "Geometric", "description": "Sim-based geocoding", "sardine_primitive": None, "sardine_location": None, "status": "out-of-scope"},
    {"operator": "Ellipsoid-Correction", "category": "Geometric", "description": "Simple geocoding", "sardine_primitive": "Coord arrays from HDF5", "sardine_location": "nisar-loader.js", "status": "equivalent"},
    {"operator": "Reproject", "category": "Geometric", "description": "CRS reprojection", "sardine_primitive": None, "sardine_location": None, "status": "out-of-scope"},
    {"operator": "Subset", "category": "Data Management", "description": "Spatial subset", "sardine_primitive": "Viewport-driven chunk selection", "sardine_location": "h5chunk.js, nisar-loader.js", "status": "exact"},
    {"operator": "Resample", "category": "Geometric", "description": "Pixel resampling", "sardine_primitive": "Bilinear interp + multilook", "sardine_location": "nisar-loader.js", "status": "equivalent"},
    {"operator": "Read", "category": "I/O", "description": "Read product", "sardine_primitive": "h5chunk, geotiff.js, File API", "sardine_location": "h5chunk.js, cog-loader.js", "status": "exact"},
    {"operator": "Write", "category": "I/O", "description": "Write product", "sardine_primitive": "GeoTIFF export", "sardine_location": "geotiff-writer.js", "status": "exact"},
    {"operator": "Land-Sea-Mask", "category": "Masking", "description": "Land/sea mask", "sardine_primitive": "Overture Maps vector overlay", "sardine_location": "OvertureLayer.js", "status": "equivalent"},
    {"operator": "ValidPixelExpression", "category": "Masking", "description": "Pixel mask", "sardine_primitive": "NaN/zero mask + NISAR mask texture", "sardine_location": "shaders.js:232, SARGPULayer.js", "status": "equivalent"},
    {"operator": "Interferogram", "category": "InSAR", "description": "Form interferogram", "sardine_primitive": None, "sardine_location": None, "status": "fft-dependent"},
    {"operator": "GoldsteinPhaseFiltering", "category": "InSAR", "description": "Phase filter", "sardine_primitive": None, "sardine_location": None, "status": "fft-dependent"},
    {"operator": "PhaseUnwrapping", "category": "InSAR", "description": "Phase unwrapping", "sardine_primitive": None, "sardine_location": None, "status": "fft-dependent"},
    {"operator": "Coherence", "category": "InSAR", "description": "Coherence estimation", "sardine_primitive": None, "sardine_location": None, "status": "fft-dependent"},
    {"operator": "Coregistration", "category": "InSAR", "description": "SLC coregistration", "sardine_primitive": None, "sardine_location": None, "status": "fft-dependent"},
]

def compute_coverage(operators):
    stats = {"total": len(operators), "by_status": {}, "by_category": {}}
    for op in operators:
        s = op["status"]
        stats["by_status"][s] = stats["by_status"].get(s, 0) + 1
        cat = op["category"]
        if cat not in stats["by_category"]:
            stats["by_category"][cat] = {"total": 0, "covered": 0}
        stats["by_category"][cat]["total"] += 1
        if s in ("exact", "equivalent", "partial"):
            stats["by_category"][cat]["covered"] += 1
    post_slc = [o for o in operators if o["status"] not in ("fft-dependent", "out-of-scope")]
    covered = [o for o in post_slc if o["status"] in ("exact", "equivalent", "partial")]
    stats["post_slc_total"] = len(post_slc)
    stats["post_slc_covered"] = len(covered)
    stats["post_slc_pct"] = round(100 * len(covered) / len(post_slc), 1) if post_slc else 0
    return stats

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    results_dir = os.path.join(script_dir, "results")
    os.makedirs(results_dir, exist_ok=True)
    print("=" * 60)
    print("Benchmark 1: SNAP GPT Primitive Coverage Matrix")
    print("=" * 60)
    csv_path = os.path.join(results_dir, "snap_coverage.csv")
    fields = ["operator", "category", "description", "status", "sardine_primitive", "sardine_location", "note"]
    with open(csv_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for op in SNAP_OPERATORS:
            writer.writerow({k: op.get(k, "") or "" for k in fields})
    print(f"  CSV: {csv_path}")
    stats = compute_coverage(SNAP_OPERATORS)
    print(f"  Total: {stats['total']}  Post-SLC: {stats['post_slc_total']}  Covered: {stats['post_slc_covered']} ({stats['post_slc_pct']}%)")
    for s, c in sorted(stats["by_status"].items()):
        print(f"    {s}: {c}")
    status = "PASS" if stats["post_slc_pct"] >= 80 else "FAIL"
    print(f"  {status}: {stats['post_slc_pct']}% {'>=80%' if status == 'PASS' else '<80%'}")
    try:
        import matplotlib; matplotlib.use("Agg")
        import matplotlib.pyplot as plt; import numpy as np
        cats = sorted(stats["by_category"].keys())
        covered = [stats["by_category"][c]["covered"] for c in cats]
        total = [stats["by_category"][c]["total"] for c in cats]
        not_cov = [t - c for t, c in zip(total, covered)]
        fig, ax = plt.subplots(figsize=(10, 5))
        x = np.arange(len(cats))
        ax.bar(x, covered, 0.6, label="Covered", color="#4ec9d4")
        ax.bar(x, not_cov, 0.6, bottom=covered, label="Not covered", color="#2a2a3a")
        ax.set_ylabel("Operators"); ax.set_title("SNAP GPT Coverage by SARdine Primitives")
        ax.set_xticks(x); ax.set_xticklabels(cats, rotation=35, ha="right", fontsize=8); ax.legend()
        for i, (c, t) in enumerate(zip(covered, total)):
            ax.text(i, t + 0.2, f"{round(100*c/t) if t else 0}%", ha="center", fontsize=8, fontweight="bold")
        plt.tight_layout()
        fig_path = os.path.join(results_dir, "fig_primitive_coverage.pdf")
        plt.savefig(fig_path, dpi=150, bbox_inches="tight"); plt.close()
        print(f"  Figure: {fig_path}")
    except ImportError: print("  [SKIP] matplotlib not available")
    summary = {"benchmark": "1_primitive_coverage", "post_slc_coverage_pct": stats["post_slc_pct"],
               "post_slc_total": stats["post_slc_total"], "post_slc_covered": stats["post_slc_covered"],
               "by_status": stats["by_status"], "pass": stats["post_slc_pct"] >= 80}
    with open(os.path.join(results_dir, "bench1_summary.json"), "w") as f:
        json.dump(summary, f, indent=2)
    return 0 if stats["post_slc_pct"] >= 80 else 1

if __name__ == "__main__":
    sys.exit(main())
