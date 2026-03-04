#!/usr/bin/env python3
"""Generate all benchmark figures from results JSON/CSV files."""
import json, os, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

RESULTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")

def fig_gpu_speedup():
    """Benchmark 2: GPU speedup log-log plot."""
    cpu_path = os.path.join(RESULTS_DIR, "bench2_cpu_cuda.json")
    if not os.path.exists(cpu_path): return print("  [SKIP] bench2_cpu_cuda.json not found")
    with open(cpu_path) as f: data = json.load(f)

    ops = sorted(set(r["operation"] for r in data if r["backend"] == "cupy"))
    if not ops: return print("  [SKIP] No CUDA results")

    fig, axes = plt.subplots(2, 4, figsize=(16, 7), squeeze=False)
    for idx, op in enumerate(ops):
        ax = axes[idx // 4][idx % 4]
        cuda = [r for r in data if r["operation"] == op and r["backend"] == "cupy" and r.get("speedup_vs_cpu")]
        if cuda:
            sizes = [r["size"] for r in cuda]; speedups = [r["speedup_vs_cpu"] for r in cuda]
            ax.plot(sizes, speedups, "s-", color="#76b900", label="CUDA (CuPy)", markersize=6)
        ax.set_xscale("log", base=2); ax.set_yscale("log")
        ax.set_title(op.replace("_", " ").title(), fontsize=9)
        ax.set_xlabel("Size"); ax.set_ylabel("Speedup")
        ax.axhline(y=10, color="#555", linestyle="--", linewidth=0.5)
        ax.grid(True, alpha=0.2); ax.legend(fontsize=7)
    for i in range(len(ops), 8): axes[i//4][i%4].set_visible(False)
    plt.suptitle("GPU Speedup Over CPU (NumPy)", fontweight="bold")
    plt.tight_layout()
    plt.savefig(os.path.join(RESULTS_DIR, "fig_gpu_speedup.pdf"), dpi=150, bbox_inches="tight")
    plt.close(); print("  fig_gpu_speedup.pdf")

def fig_streaming():
    """Benchmark 4: h5chunk streaming efficiency."""
    path = os.path.join(RESULTS_DIR, "bench4_summary.json")
    if not os.path.exists(path): return print("  [SKIP] bench4_summary.json not found")
    with open(path) as f: data = json.load(f)
    regions = data.get("regions", [])
    if not regions: return

    sizes = [r["regionSize"] for r in regions]
    times = [r["medianTimeMs"] for r in regions]
    ratios = [r["transferRatio"] for r in regions]

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10, 4))
    ax1.bar(range(len(sizes)), times, color="#4ec9d4")
    ax1.set_xticks(range(len(sizes))); ax1.set_xticklabels([f"{s}x{s}" for s in sizes])
    ax1.set_ylabel("Time (ms)"); ax1.set_title("Time to First Pixel")
    ax1.axhline(y=100, color="#e05858", linestyle="--", label="100ms target"); ax1.legend()
    for i, t in enumerate(times): ax1.text(i, t+5, f"{t:.0f}ms", ha="center", fontsize=9)

    ax2.bar(range(len(sizes)), ratios, color="#76b900")
    ax2.set_xticks(range(len(sizes))); ax2.set_xticklabels([f"{s}x{s}" for s in sizes])
    ax2.set_ylabel("Bytes Read / Bytes Needed"); ax2.set_title("Transfer Ratio")
    ax2.axhline(y=1.0, color="#888", linestyle="--", label="Ideal"); ax2.legend()
    for i, r in enumerate(ratios): ax2.text(i, r+0.1, f"{r:.1f}x", ha="center", fontsize=9)

    plt.suptitle("h5chunk Streaming Performance", fontweight="bold")
    plt.tight_layout()
    plt.savefig(os.path.join(RESULTS_DIR, "fig_streaming_efficiency.pdf"), dpi=150, bbox_inches="tight")
    plt.close(); print("  fig_streaming_efficiency.pdf")

def fig_interactive():
    """Benchmark 5: Frame times box plot."""
    path = os.path.join(RESULTS_DIR, "bench5_interactive.json")
    if not os.path.exists(path): return print("  [SKIP] bench5_interactive.json not found")
    with open(path) as f: data = json.load(f)
    if "error" in data: return print(f"  [SKIP] {data['error']}")

    names = list(data.keys())
    p50 = [data[n]["p50"] for n in names]
    p95 = [data[n]["p95"] for n in names]
    p99 = [data[n]["p99"] for n in names]

    fig, ax = plt.subplots(figsize=(10, 5))
    x = np.arange(len(names)); w = 0.25
    ax.bar(x-w, p50, w, label="p50", color="#4ec9d4")
    ax.bar(x, p95, w, label="p95", color="#76b900")
    ax.bar(x+w, p99, w, label="p99", color="#e05858")
    ax.axhline(y=16.0, color="#e05858", linestyle="--", linewidth=1.5, label="16ms (60fps)")
    ax.set_ylabel("Frame Time (ms)"); ax.set_title("Interactive Responsiveness")
    ax.set_xticks(x); ax.set_xticklabels([n.replace("_", "\n") for n in names], fontsize=8)
    ax.legend(fontsize=8); ax.grid(True, alpha=0.2, axis="y")
    plt.tight_layout()
    plt.savefig(os.path.join(RESULTS_DIR, "fig_frame_times.pdf"), dpi=150, bbox_inches="tight")
    plt.close(); print("  fig_frame_times.pdf")

def compile_summary():
    """Compile all benchmark summaries into one file."""
    summary = {}
    for f in sorted(os.listdir(RESULTS_DIR)):
        if f.endswith("_summary.json"):
            with open(os.path.join(RESULTS_DIR, f)) as fh:
                data = json.load(fh)
                key = data.get("benchmark", f)
                summary[key] = data
    with open(os.path.join(RESULTS_DIR, "summary.json"), "w") as fh:
        json.dump(summary, fh, indent=2)
    print(f"  summary.json compiled ({len(summary)} benchmarks)")

if __name__ == "__main__":
    print("Generating figures...")
    fig_gpu_speedup()
    fig_streaming()
    fig_interactive()
    compile_summary()
    print("Done.")
