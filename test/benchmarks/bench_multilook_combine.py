#!/usr/bin/env python3
"""Combine multilook benchmark results (CPU/CUDA + WebGL2) and generate figure.

Merges bench_multilook_cpu.json + bench_multilook_webgl.json into a unified
comparison table and PDF figure showing:
  - Kernel size x Scene size grid
  - 4 backends: NumPy, scipy, CuPy (CUDA), WebGL2
  - Speedup vs scipy (the fast CPU baseline)
"""
import json, os, csv
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

RESULTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")

def main():
    print("=== Multilook Benchmark: Combine Results ===")
    print("All averaging in LINEAR POWER space (never dB)")

    # Load CPU/CUDA results
    cpu_path = os.path.join(RESULTS_DIR, "bench_multilook_cpu.json")
    with open(cpu_path) as f:
        cpu_data = json.load(f)
    print(f"  CPU/CUDA: {len(cpu_data)} measurements from {cpu_path}")

    # Load WebGL2 results
    webgl_path = os.path.join(RESULTS_DIR, "bench_multilook_webgl.json")
    with open(webgl_path) as f:
        webgl_data = json.load(f)
    print(f"  WebGL2: {len(webgl_data)} measurements from {webgl_path}")

    all_data = cpu_data + webgl_data

    # Extract dimensions
    sizes = sorted(set(r["scene_size"] for r in all_data))
    kernels = sorted(set(r["kernel_size"] for r in all_data))
    backends = sorted(set(r["backend"] for r in all_data))
    print(f"  Sizes: {sizes}")
    print(f"  Kernels: {kernels}")
    print(f"  Backends: {backends}")

    # Write combined CSV
    csv_path = os.path.join(RESULTS_DIR, "bench_multilook_combined.csv")
    fields = ["scene_size", "kernel_size", "looks", "backend", "median_ms",
              "mean_ms", "std_ms", "mpixels_per_sec"]
    with open(csv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for r in all_data:
            w.writerow(r)
    print(f"  Combined CSV: {csv_path}")

    # Build lookup
    def get(backend, kernel, size):
        for r in all_data:
            if r["backend"] == backend and r["kernel_size"] == kernel and r["scene_size"] == size:
                return r
        return None

    # ── Print comparison table ──
    print("\n── Multilook Timing (ms): median ──")
    header = "Kernel  Size".ljust(18) + "".join(b.rjust(12) for b in backends)
    print(header)
    print("-" * len(header))
    for ks in kernels:
        for sz in sizes:
            label = f"{ks}x{ks}  {sz}".ljust(18)
            vals = []
            for b in backends:
                r = get(b, ks, sz)
                if r:
                    vals.append(f"{r['median_ms']:>10.3f}ms")
                else:
                    vals.append("         —")
            print(label + "".join(vals))
        print()

    # ── Compute speedups vs scipy ──
    print("── Speedup vs scipy ──")
    gpu_backends = [b for b in backends if b not in ("numpy", "scipy")]
    header2 = "Kernel  Size".ljust(18) + "".join(b.rjust(12) for b in gpu_backends)
    print(header2)
    print("-" * len(header2))
    speedup_data = []
    for ks in kernels:
        for sz in sizes:
            scipy_r = get("scipy", ks, sz)
            if not scipy_r:
                continue
            label = f"{ks}x{ks}  {sz}".ljust(18)
            vals = []
            for b in gpu_backends:
                r = get(b, ks, sz)
                if r and r["median_ms"] > 0:
                    sp = scipy_r["median_ms"] / r["median_ms"]
                    vals.append(f"{sp:>10.1f}x")
                    speedup_data.append({
                        "kernel_size": ks, "scene_size": sz,
                        "backend": b, "speedup_vs_scipy": sp,
                        "gpu_ms": r["median_ms"], "scipy_ms": scipy_r["median_ms"]
                    })
                else:
                    vals.append("         —")
            print(label + "".join(vals))
        print()

    # ── Generate Figure ──
    fig, axes = plt.subplots(1, len(kernels), figsize=(4.5 * len(kernels), 4.5),
                             sharey=True, squeeze=False)

    colors = {
        "numpy": "#e05858",
        "scipy": "#ffa500",
        "cupy": "#76b900",
        "webgl2": "#4ec9d4"
    }
    markers = {"numpy": "^", "scipy": "D", "cupy": "s", "webgl2": "o"}
    labels_map = {
        "numpy": "NumPy (integral image)",
        "scipy": "scipy.ndimage",
        "cupy": "CuPy/CUDA (integral image)",
        "webgl2": "WebGL2 (fragment shader)"
    }

    for ki, ks in enumerate(kernels):
        ax = axes[0][ki]
        for b in backends:
            pts = [(r["scene_size"], r["median_ms"])
                   for r in all_data
                   if r["backend"] == b and r["kernel_size"] == ks]
            if pts:
                pts.sort()
                xs, ys = zip(*pts)
                ax.plot(xs, ys,
                        marker=markers.get(b, "x"),
                        color=colors.get(b, "#888"),
                        label=labels_map.get(b, b),
                        markersize=7, linewidth=2)

        ax.set_xscale("log", base=2)
        ax.set_yscale("log")
        ax.set_title(f"{ks}x{ks} kernel ({ks*ks} looks)", fontsize=11, fontweight="bold")
        ax.set_xlabel("Scene Size (pixels per side)")
        if ki == 0:
            ax.set_ylabel("Multilook Time (ms)")
        ax.axhline(y=16, color="#e05858", linestyle="--", linewidth=1, alpha=0.5, label="16ms (60fps)" if ki == 0 else None)
        ax.grid(True, alpha=0.2)
        ax.set_xticks(sizes)
        ax.set_xticklabels([f"{s}" for s in sizes])
        if ki == 0:
            ax.legend(fontsize=7, loc="upper left")

    plt.suptitle("Box-Filter Multilook: GPU vs CPU\n(linear power, zero-pixel masking)",
                 fontweight="bold", fontsize=13)
    plt.tight_layout()
    fig_path = os.path.join(RESULTS_DIR, "fig_multilook_comparison.pdf")
    plt.savefig(fig_path, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"\n  Figure: {fig_path}")

    # ── Summary JSON ──
    summary = {
        "benchmark": "multilook_box_filter",
        "description": "NxN box-filter multilook in linear power space",
        "backends": backends,
        "kernel_sizes": kernels,
        "scene_sizes": sizes,
        "domain_constraint": "All averaging in linear power (never dB)",
        "all_gpu_under_16ms": all(
            r["median_ms"] < 16 for r in all_data if r["backend"] in ("webgl2", "cupy")
        ),
        "peak_speedups": {},
        "crossover_analysis": {},
    }

    # Peak speedup per GPU backend
    for b in gpu_backends:
        sp_list = [s for s in speedup_data if s["backend"] == b]
        if sp_list:
            best = max(sp_list, key=lambda x: x["speedup_vs_scipy"])
            summary["peak_speedups"][b] = {
                "vs_scipy": round(best["speedup_vs_scipy"], 1),
                "kernel": best["kernel_size"],
                "scene_size": best["scene_size"],
                "gpu_ms": round(best["gpu_ms"], 3),
                "scipy_ms": round(best["scipy_ms"], 1)
            }

    # Check if all GPU backends are faster than scipy at all sizes
    for b in gpu_backends:
        always_faster = True
        for ks in kernels:
            for sz in sizes:
                scipy_r = get("scipy", ks, sz)
                gpu_r = get(b, ks, sz)
                if scipy_r and gpu_r and gpu_r["median_ms"] >= scipy_r["median_ms"]:
                    always_faster = False
        summary["crossover_analysis"][b] = {
            "always_faster_than_scipy": always_faster
        }

    summary_path = os.path.join(RESULTS_DIR, "bench_multilook_summary.json")
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)
    print(f"  Summary: {summary_path}")

    # Print headline
    print("\n── Key Results ──")
    for b, info in summary["peak_speedups"].items():
        print(f"  {labels_map.get(b, b)}: {info['vs_scipy']}x faster than scipy "
              f"({info['kernel']}x{info['kernel']} @ {info['scene_size']}, "
              f"{info['gpu_ms']}ms vs {info['scipy_ms']}ms)")

    all_gpu_ok = summary["all_gpu_under_16ms"]
    print(f"  All GPU timings < 16ms (60fps interactive): {'PASS' if all_gpu_ok else 'FAIL'}")

if __name__ == "__main__":
    main()
