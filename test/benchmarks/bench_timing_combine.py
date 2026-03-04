#!/usr/bin/env python3
"""Benchmark 2: Combine CPU/CUDA + WebGL2 timing results into unified CSV + figure."""
import json, os, csv
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

RESULTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")

def load_cpu_cuda():
    """Load CPU/CUDA results from CSV."""
    path = os.path.join(RESULTS_DIR, "bench2_cpu_cuda.csv")
    if not os.path.exists(path):
        print(f"  [SKIP] {path} not found")
        return []
    rows = []
    with open(path) as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append({
                "operation": row["operation"],
                "size": int(row["size"]),
                "backend": row["backend"],
                "median_ms": float(row["median_ms"]),
                "mean_ms": float(row.get("mean_ms", row["median_ms"])),
            })
    return rows

def load_webgl():
    """Load WebGL2 results from JSON."""
    path = os.path.join(RESULTS_DIR, "bench2_webgl.json")
    if not os.path.exists(path):
        print(f"  [SKIP] {path} not found")
        return []
    with open(path) as f:
        data = json.load(f)
    if isinstance(data, dict) and "error" in data:
        print(f"  [SKIP] WebGL error: {data['error']}")
        return []
    return data

def main():
    print("=== Benchmark 2: Combine Results ===")

    cpu_cuda = load_cpu_cuda()
    webgl = load_webgl()
    all_data = cpu_cuda + webgl

    if not all_data:
        print("No data to combine")
        return

    # Write combined CSV
    csv_path = os.path.join(RESULTS_DIR, "bench2_combined.csv")
    fields = ["operation", "size", "backend", "median_ms", "mean_ms"]
    with open(csv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for row in all_data:
            w.writerow(row)
    print(f"  Combined CSV: {csv_path} ({len(all_data)} rows)")

    # Build speedup data (relative to NumPy CPU baseline)
    ops = sorted(set(r["operation"] for r in all_data))
    sizes = sorted(set(r["size"] for r in all_data))
    backends = sorted(set(r["backend"] for r in all_data if r["backend"] != "numpy"))

    # Get CPU baselines
    cpu_base = {}
    for r in all_data:
        if r["backend"] == "numpy":
            cpu_base[(r["operation"], r["size"])] = r["median_ms"]

    # Compute speedups
    for r in all_data:
        base = cpu_base.get((r["operation"], r["size"]))
        if base and base > 0:
            r["speedup_vs_cpu"] = base / r["median_ms"]
        else:
            r["speedup_vs_cpu"] = None

    # Filter ops that have at least one GPU backend
    plot_ops = [op for op in ops if any(
        r["operation"] == op and r["backend"] != "numpy" and r.get("speedup_vs_cpu")
        for r in all_data
    )]

    if not plot_ops:
        print("  No GPU speedup data to plot")
        return

    # Plot: one subplot per operation
    n_ops = len(plot_ops)
    cols = min(4, n_ops)
    rows = (n_ops + cols - 1) // cols
    fig, axes = plt.subplots(rows, cols, figsize=(4 * cols, 3.5 * rows), squeeze=False)

    colors = {"webgl2": "#4ec9d4", "cupy": "#76b900"}
    markers = {"webgl2": "o", "cupy": "s"}
    labels = {"webgl2": "WebGL2", "cupy": "CUDA (CuPy)"}

    for idx, op in enumerate(plot_ops):
        ax = axes[idx // cols][idx % cols]
        for backend in backends:
            pts = [r for r in all_data
                   if r["operation"] == op and r["backend"] == backend and r.get("speedup_vs_cpu")]
            if pts:
                xs = [r["size"] for r in pts]
                ys = [r["speedup_vs_cpu"] for r in pts]
                ax.plot(xs, ys,
                        marker=markers.get(backend, "^"),
                        color=colors.get(backend, "#888"),
                        label=labels.get(backend, backend),
                        markersize=6, linewidth=1.5)

        ax.set_xscale("log", base=2)
        ax.set_yscale("log")
        ax.set_title(op.replace("_", " ").title(), fontsize=9)
        ax.set_xlabel("Image Size")
        ax.set_ylabel("Speedup vs CPU")
        ax.axhline(y=10, color="#555", linestyle="--", linewidth=0.5, alpha=0.5)
        ax.axhline(y=100, color="#555", linestyle=":", linewidth=0.5, alpha=0.3)
        ax.grid(True, alpha=0.2)
        ax.legend(fontsize=7)

    # Hide empty subplots
    for i in range(len(plot_ops), rows * cols):
        axes[i // cols][i % cols].set_visible(False)

    plt.suptitle("GPU Speedup Over CPU (NumPy)", fontweight="bold", fontsize=14)
    plt.tight_layout()
    fig_path = os.path.join(RESULTS_DIR, "fig_gpu_speedup.pdf")
    plt.savefig(fig_path, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"  Figure: {fig_path}")

    # Write summary JSON
    summary = {
        "benchmark": "2_gpu_timing",
        "backends": list(set(r["backend"] for r in all_data)),
        "operations": ops,
        "sizes": sizes,
        "max_speedups": {}
    }
    for backend in backends:
        pts = [r for r in all_data if r["backend"] == backend and r.get("speedup_vs_cpu")]
        if pts:
            best = max(pts, key=lambda r: r["speedup_vs_cpu"])
            summary["max_speedups"][backend] = {
                "speedup": round(best["speedup_vs_cpu"], 1),
                "operation": best["operation"],
                "size": best["size"]
            }

    summary_path = os.path.join(RESULTS_DIR, "bench2_summary.json")
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)
    print(f"  Summary: {summary_path}")

    # Print headline numbers
    print("\n  Peak speedups:")
    for backend, info in summary["max_speedups"].items():
        print(f"    {labels.get(backend, backend)}: {info['speedup']:.1f}x ({info['operation']} @ {info['size']})")

if __name__ == "__main__":
    main()
