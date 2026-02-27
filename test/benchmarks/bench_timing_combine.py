#!/usr/bin/env python3
"""
Benchmark 2d: Combine CPU/CUDA/WebGL2 Results

Merges bench2_cpu_cuda.csv and bench2_webgl.json into a unified CSV
and generates a log-log speedup figure.
"""

import csv
import json
import os
import sys

import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RESULTS_DIR = os.path.join(SCRIPT_DIR, "results")


def load_cpu_cuda():
    """Load CPU/CUDA results from CSV."""
    path = os.path.join(RESULTS_DIR, "bench2_cpu_cuda.csv")
    if not os.path.exists(path):
        print(f"  WARNING: {path} not found")
        return []
    results = []
    with open(path) as f:
        for row in csv.DictReader(f):
            for k in ["mean_ms", "median_ms", "p95_ms", "min_ms", "max_ms"]:
                if row.get(k):
                    row[k] = float(row[k])
            if row.get("size"):
                row["size"] = int(row["size"])
            if row.get("pixels"):
                row["pixels"] = int(row["pixels"])
            results.append(row)
    return results


def load_webgl():
    """Load WebGL2 results from JSON."""
    path = os.path.join(RESULTS_DIR, "bench2_webgl.json")
    if not os.path.exists(path):
        print(f"  WARNING: {path} not found")
        return []
    with open(path) as f:
        data = json.load(f)
    if isinstance(data, dict) and "error" in data:
        print(f"  WARNING: WebGL benchmark errored: {data['error']}")
        return []
    return data


def compute_speedups(combined):
    """Add speedup columns relative to CPU baseline."""
    for r in combined:
        if r["backend"] in ("cupy", "webgl2"):
            cpu = next(
                (x for x in combined
                 if x["backend"] == "numpy"
                 and x["operation"] == r["operation"]
                 and x["size"] == r["size"]),
                None,
            )
            if cpu and r.get("median_ms", 0) > 0:
                r["speedup_vs_cpu"] = round(cpu["median_ms"] / r["median_ms"], 2)


def write_combined_csv(combined):
    """Write unified CSV."""
    path = os.path.join(RESULTS_DIR, "bench2_combined.csv")
    fields = [
        "operation", "size", "pixels", "backend",
        "mean_ms", "median_ms", "p95_ms", "min_ms", "max_ms",
        "speedup_vs_cpu",
    ]
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for r in combined:
            writer.writerow({k: r.get(k, "") for k in fields})
    print(f"  Combined CSV: {path}")
    return path


def generate_figure(combined):
    """Generate log-log speedup figure."""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        print("  [SKIP] matplotlib not available")
        return

    operations = sorted(set(r["operation"] for r in combined if r["backend"] != "numpy"))
    # Map operations to display names
    op_names = {
        "dB_conversion": "dB Conversion",
        "sqrt_stretch": "Sqrt Stretch",
        "gamma_stretch": "Gamma Stretch",
        "sigmoid_stretch": "Sigmoid Stretch",
        "viridis_colormap": "Viridis Colormap",
        "multilook_4x4": "Multilook 4x4",
        "rgb_composite_pauli": "RGB Composite",
        "full_pipeline": "Full Pipeline",
    }

    backends = sorted(set(r["backend"] for r in combined if r["backend"] != "numpy"))
    backend_colors = {"cupy": "#76b900", "webgl2": "#4ec9d4"}
    backend_markers = {"cupy": "s", "webgl2": "o"}
    backend_labels = {"cupy": "CUDA (CuPy)", "webgl2": "WebGL2 (Browser)"}

    # Filter to operations that have speedup data
    ops_with_data = [op for op in operations
                     if any(r.get("speedup_vs_cpu") for r in combined
                            if r["operation"] == op and r["backend"] != "numpy")]

    if not ops_with_data:
        print("  [SKIP] No speedup data to plot")
        return

    n_ops = len(ops_with_data)
    cols = min(4, n_ops)
    rows = (n_ops + cols - 1) // cols
    fig, axes = plt.subplots(rows, cols, figsize=(4 * cols, 3.5 * rows), squeeze=False)

    for idx, op in enumerate(ops_with_data):
        ax = axes[idx // cols][idx % cols]
        ax.set_title(op_names.get(op, op), fontsize=10, fontweight="bold")

        for backend in backends:
            data = [r for r in combined
                    if r["operation"] == op and r["backend"] == backend
                    and r.get("speedup_vs_cpu")]
            if not data:
                continue
            sizes = [r["size"] for r in data]
            speedups = [r["speedup_vs_cpu"] for r in data]
            ax.plot(sizes, speedups,
                    marker=backend_markers.get(backend, "^"),
                    color=backend_colors.get(backend, "#888"),
                    label=backend_labels.get(backend, backend),
                    linewidth=1.5, markersize=6)

        ax.set_xscale("log", base=2)
        ax.set_yscale("log")
        ax.set_xlabel("Image Size (px)")
        ax.set_ylabel("Speedup vs CPU")
        ax.axhline(y=10, color="#555", linestyle="--", linewidth=0.5, alpha=0.5)
        ax.axhline(y=100, color="#555", linestyle="--", linewidth=0.5, alpha=0.5)
        ax.legend(fontsize=7, loc="upper left")
        ax.grid(True, alpha=0.2)
        ax.set_xticks([512, 2048, 8192, 16384])
        ax.set_xticklabels(["512", "2K", "8K", "16K"], fontsize=8)

    # Hide empty subplots
    for idx in range(n_ops, rows * cols):
        axes[idx // cols][idx % cols].set_visible(False)

    plt.suptitle("GPU Speedup Over CPU (NumPy) by Operation", fontweight="bold", fontsize=12)
    plt.tight_layout()
    fig_path = os.path.join(RESULTS_DIR, "fig_gpu_speedup.pdf")
    plt.savefig(fig_path, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"  Figure: {fig_path}")


def main():
    print("=" * 60)
    print("Benchmark 2d: Combine CPU/CUDA/WebGL2 Results")
    print("=" * 60)

    cpu_cuda = load_cpu_cuda()
    webgl = load_webgl()

    print(f"  CPU/CUDA results: {len(cpu_cuda)}")
    print(f"  WebGL2 results: {len(webgl)}")

    # Normalize WebGL results
    for r in webgl:
        # Rename full_pipeline → match operations
        if r.get("operation") == "full_pipeline":
            pass  # keep as-is, it's a separate test
        r.setdefault("backend", "webgl2")

    combined = cpu_cuda + webgl
    compute_speedups(combined)
    write_combined_csv(combined)
    generate_figure(combined)

    # Print summary
    print("\n  --- Speedup Summary (median) ---")
    backends = sorted(set(r["backend"] for r in combined if r["backend"] != "numpy"))
    for backend in backends:
        speedups = [r["speedup_vs_cpu"] for r in combined
                    if r["backend"] == backend and r.get("speedup_vs_cpu")]
        if speedups:
            print(f"  {backend}: median={np.median(speedups):.1f}x, "
                  f"max={max(speedups):.1f}x, min={min(speedups):.1f}x")

    # Write summary JSON
    summary = {
        "benchmark": "2_gpu_timing",
        "backends": {},
    }
    for backend in backends:
        speedups = [r["speedup_vs_cpu"] for r in combined
                    if r["backend"] == backend and r.get("speedup_vs_cpu")]
        if speedups:
            summary["backends"][backend] = {
                "median_speedup": round(float(np.median(speedups)), 1),
                "max_speedup": round(max(speedups), 1),
                "min_speedup": round(min(speedups), 1),
            }
    with open(os.path.join(RESULTS_DIR, "bench2_summary.json"), "w") as f:
        json.dump(summary, f, indent=2)

    return 0


if __name__ == "__main__":
    sys.exit(main())
