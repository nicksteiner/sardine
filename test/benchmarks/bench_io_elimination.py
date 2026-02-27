#!/usr/bin/env python3
"""
Benchmark 3: I/O Elimination (Pipeline Chaining)

Compares file-based intermediate I/O (SNAP-style GPT processing)
vs in-memory chained pipeline vs CUDA chained pipeline.

Pipeline: Calibrate -> Multilook 4x4 -> Speckle Filter (3x3 mean) -> dB -> Viridis Colormap
"""

import csv
import json
import os
import sys
import tempfile
import time

import numpy as np

try:
    import rasterio
    from rasterio.transform import from_bounds
    HAS_RASTERIO = True
except ImportError:
    HAS_RASTERIO = False
    print("WARNING: rasterio not available. File-based pipeline will use np.save/load instead.")

try:
    import cupy as cp
    HAS_CUPY = True
except ImportError:
    HAS_CUPY = False

# Viridis coefficients (matching shaders.js)
VIR_R = [0.2777, 0.1050, -0.3308, -4.6342, 6.2282, 4.7763, -5.4354]
VIR_G = [0.0054, 0.6389, 0.2149, -5.7991, 14.1799, -13.7451, 4.6456]
VIR_B = [0.3340, 0.7916, 0.0948, -19.3324, 56.6905, -65.3530, 26.3124]

SIZES = [2048, 8192]
TRIALS = 3
WARMUP = 1
CAL_FACTOR = 1.0  # Trivial calibration constant


def horner(t, coeffs, xp):
    result = xp.full_like(t, coeffs[6])
    for i in range(5, -1, -1):
        result = result * t + coeffs[i]
    return result


def generate_sar_data(N, xp=np):
    rng = xp.random.default_rng(42)
    return xp.exp(rng.standard_normal((N, N), dtype=xp.float32) * 2.0 - 1.0) * 0.01


# --- Pipeline stages (NumPy) ---

def calibrate_np(data):
    return data * CAL_FACTOR


def multilook_np(data, ml=4):
    H, W = data.shape
    Ho, Wo = H // ml, W // ml
    return data[:Ho * ml, :Wo * ml].reshape(Ho, ml, Wo, ml).mean(axis=(1, 3))


def speckle_filter_np(data):
    """3x3 mean filter via uniform_filter-like manual convolution."""
    H, W = data.shape
    out = np.zeros((H - 2, W - 2), dtype=np.float32)
    for dy in range(3):
        for dx in range(3):
            out += data[dy:dy + H - 2, dx:dx + W - 2]
    return out / 9.0


def db_convert_np(data):
    return 10.0 * np.log10(np.maximum(data, 1e-10))


def viridis_np(data):
    t = np.clip(data, 0, 1).astype(np.float32)
    r = horner(t, VIR_R, np)
    g = horner(t, VIR_G, np)
    b = horner(t, VIR_B, np)
    return np.stack([r, g, b], axis=-1)


# --- File I/O helpers ---

def write_array(path, data):
    if HAS_RASTERIO:
        H, W = data.shape[:2]
        bands = data.shape[2] if data.ndim == 3 else 1
        transform = from_bounds(0, 0, W, H, W, H)
        with rasterio.open(
            path, "w", driver="GTiff", height=H, width=W,
            count=bands, dtype="float32", transform=transform,
        ) as dst:
            if bands == 1:
                dst.write(data, 1)
            else:
                for b in range(bands):
                    dst.write(data[:, :, b], b + 1)
    else:
        np.save(path, data)


def read_array(path):
    if HAS_RASTERIO:
        with rasterio.open(path) as src:
            if src.count == 1:
                return src.read(1)
            else:
                return np.stack([src.read(b + 1) for b in range(src.count)], axis=-1)
    else:
        return np.load(path)


# --- Pipeline runners ---

def run_file_based(data, tmpdir):
    """SNAP-style: compute stage, write intermediate, re-read for next stage."""
    ext = ".tif" if HAS_RASTERIO else ".npy"
    stage_times = {}
    io_time = 0.0

    # Stage 1: Calibrate
    t0 = time.perf_counter()
    cal = calibrate_np(data)
    stage_times["calibrate"] = (time.perf_counter() - t0) * 1000

    t0 = time.perf_counter()
    p1 = os.path.join(tmpdir, f"s1_cal{ext}")
    write_array(p1, cal)
    cal = read_array(p1)
    io_time += (time.perf_counter() - t0) * 1000

    # Stage 2: Multilook
    t0 = time.perf_counter()
    ml = multilook_np(cal)
    stage_times["multilook"] = (time.perf_counter() - t0) * 1000

    t0 = time.perf_counter()
    p2 = os.path.join(tmpdir, f"s2_ml{ext}")
    write_array(p2, ml)
    ml = read_array(p2)
    io_time += (time.perf_counter() - t0) * 1000

    # Stage 3: Speckle filter
    t0 = time.perf_counter()
    sf = speckle_filter_np(ml)
    stage_times["speckle_filter"] = (time.perf_counter() - t0) * 1000

    t0 = time.perf_counter()
    p3 = os.path.join(tmpdir, f"s3_sf{ext}")
    write_array(p3, sf)
    sf = read_array(p3)
    io_time += (time.perf_counter() - t0) * 1000

    # Stage 4: dB
    t0 = time.perf_counter()
    db = db_convert_np(sf)
    stage_times["dB_convert"] = (time.perf_counter() - t0) * 1000

    # Normalize for colormap
    db_min, db_max = np.nanmin(db), np.nanmax(db)
    norm = np.clip((db - db_min) / (db_max - db_min + 1e-10), 0, 1).astype(np.float32)

    t0 = time.perf_counter()
    p4 = os.path.join(tmpdir, f"s4_db{ext}")
    write_array(p4, norm)
    norm = read_array(p4)
    io_time += (time.perf_counter() - t0) * 1000

    # Stage 5: Colormap
    t0 = time.perf_counter()
    rgb = viridis_np(norm)
    stage_times["colormap"] = (time.perf_counter() - t0) * 1000

    t0 = time.perf_counter()
    p5 = os.path.join(tmpdir, f"s5_rgb{ext}")
    write_array(p5, rgb)
    io_time += (time.perf_counter() - t0) * 1000

    compute_time = sum(stage_times.values())
    return {
        "method": "file_based",
        "compute_ms": round(compute_time, 3),
        "io_ms": round(io_time, 3),
        "total_ms": round(compute_time + io_time, 3),
        "io_pct": round(100 * io_time / (compute_time + io_time), 1),
        "stages": {k: round(v, 3) for k, v in stage_times.items()},
    }


def run_chained_numpy(data):
    """All operations on same in-memory array, no intermediate I/O."""
    t0 = time.perf_counter()
    x = calibrate_np(data)
    x = multilook_np(x)
    x = speckle_filter_np(x)
    x = db_convert_np(x)
    x_min, x_max = np.nanmin(x), np.nanmax(x)
    x = np.clip((x - x_min) / (x_max - x_min + 1e-10), 0, 1).astype(np.float32)
    rgb = viridis_np(x)
    elapsed = (time.perf_counter() - t0) * 1000
    return {
        "method": "chained_numpy",
        "compute_ms": round(elapsed, 3),
        "io_ms": 0.0,
        "total_ms": round(elapsed, 3),
        "io_pct": 0.0,
    }


def run_chained_cupy(data_np):
    """All operations on GPU memory, no host<->device transfers between stages."""
    if not HAS_CUPY:
        return None

    # Transfer to GPU once
    data = cp.asarray(data_np)
    cp.cuda.Device().synchronize()

    t0 = time.perf_counter()
    x = data * CAL_FACTOR  # calibrate

    # multilook
    H, W = x.shape
    Ho, Wo = H // 4, W // 4
    x = x[:Ho * 4, :Wo * 4].reshape(Ho, 4, Wo, 4).mean(axis=(1, 3))

    # speckle filter (3x3 mean)
    H2, W2 = x.shape
    out = cp.zeros((H2 - 2, W2 - 2), dtype=cp.float32)
    for dy in range(3):
        for dx in range(3):
            out += x[dy:dy + H2 - 2, dx:dx + W2 - 2]
    x = out / 9.0

    # dB
    x = 10.0 * cp.log10(cp.maximum(x, 1e-10))
    x_min, x_max = float(cp.min(x)), float(cp.max(x))
    x = cp.clip((x - x_min) / (x_max - x_min + 1e-10), 0, 1).astype(cp.float32)

    # viridis colormap
    r = horner(x, VIR_R, cp)
    g = horner(x, VIR_G, cp)
    b = horner(x, VIR_B, cp)
    rgb = cp.stack([r, g, b], axis=-1)

    cp.cuda.Device().synchronize()
    elapsed = (time.perf_counter() - t0) * 1000

    del data, x, out, rgb
    cp.get_default_memory_pool().free_all_blocks()

    return {
        "method": "chained_cupy",
        "compute_ms": round(elapsed, 3),
        "io_ms": 0.0,
        "total_ms": round(elapsed, 3),
        "io_pct": 0.0,
    }


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    results_dir = os.path.join(script_dir, "results")
    os.makedirs(results_dir, exist_ok=True)

    print("=" * 60)
    print("Benchmark 3: I/O Elimination (Pipeline Chaining)")
    print("=" * 60)
    print(f"  Pipeline: Calibrate -> Multilook 4x4 -> Speckle 3x3 -> dB -> Viridis")
    print(f"  Sizes: {SIZES}")
    print(f"  Trials: {TRIALS} (warmup: {WARMUP})")
    print(f"  File I/O backend: {'rasterio (GeoTIFF)' if HAS_RASTERIO else 'numpy (npy)'}")
    print()

    all_results = []

    for size in SIZES:
        print(f"--- Size: {size}x{size} ({size*size:,} pixels) ---")
        data = generate_sar_data(size, np)

        methods = {
            "file_based": lambda: None,
            "chained_numpy": lambda: run_chained_numpy(data),
        }
        if HAS_CUPY:
            methods["chained_cupy"] = lambda: run_chained_cupy(data)

        for method_name in ["file_based", "chained_numpy", "chained_cupy"]:
            if method_name == "chained_cupy" and not HAS_CUPY:
                continue

            trial_results = []
            for t in range(WARMUP + TRIALS):
                if method_name == "file_based":
                    with tempfile.TemporaryDirectory() as tmpdir:
                        r = run_file_based(data, tmpdir)
                elif method_name == "chained_numpy":
                    r = run_chained_numpy(data)
                elif method_name == "chained_cupy":
                    r = run_chained_cupy(data)

                if r and t >= WARMUP:
                    trial_results.append(r)

            if not trial_results:
                continue

            # Aggregate trials
            avg = {
                "method": method_name,
                "size": size,
                "pixels": size * size,
                "compute_ms": round(np.mean([r["compute_ms"] for r in trial_results]), 3),
                "io_ms": round(np.mean([r["io_ms"] for r in trial_results]), 3),
                "total_ms": round(np.mean([r["total_ms"] for r in trial_results]), 3),
                "io_pct": round(np.mean([r["io_pct"] for r in trial_results]), 1),
            }
            all_results.append(avg)

            if method_name == "file_based":
                print(f"  File-based:    compute={avg['compute_ms']:.1f}ms  I/O={avg['io_ms']:.1f}ms  total={avg['total_ms']:.1f}ms  I/O={avg['io_pct']:.0f}%")
            else:
                # Compute speedup vs file-based
                fb = next((r for r in all_results if r["method"] == "file_based" and r["size"] == size), None)
                if fb:
                    speedup = fb["total_ms"] / avg["total_ms"] if avg["total_ms"] > 0 else 0
                    io_elim = 100 * (1 - avg["io_ms"] / fb["io_ms"]) if fb["io_ms"] > 0 else 100
                    avg["speedup_vs_file"] = round(speedup, 1)
                    avg["io_elimination_pct"] = round(io_elim, 1)
                    print(f"  {method_name:16s}: compute={avg['compute_ms']:.1f}ms  total={avg['total_ms']:.1f}ms  {speedup:.1f}x faster  I/O eliminated={io_elim:.0f}%")

        print()

    # Write CSV
    csv_path = os.path.join(results_dir, "bench3_io_elimination.csv")
    fields = ["method", "size", "pixels", "compute_ms", "io_ms", "total_ms", "io_pct", "speedup_vs_file", "io_elimination_pct"]
    with open(csv_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for r in all_results:
            writer.writerow({k: r.get(k, "") for k in fields})
    print(f"Results written to: {csv_path}")

    # Generate figure
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        fig, axes = plt.subplots(1, len(SIZES), figsize=(6 * len(SIZES), 5), sharey=False)
        if len(SIZES) == 1:
            axes = [axes]

        for ax, size in zip(axes, SIZES):
            methods_data = [r for r in all_results if r["size"] == size]
            names = [r["method"].replace("_", "\n") for r in methods_data]
            compute = [r["compute_ms"] for r in methods_data]
            io = [r["io_ms"] for r in methods_data]

            x = np.arange(len(names))
            ax.bar(x, compute, 0.6, label="Compute", color="#4ec9d4")
            ax.bar(x, io, 0.6, bottom=compute, label="I/O", color="#e05858")
            ax.set_title(f"{size}x{size}")
            ax.set_xticks(x)
            ax.set_xticklabels(names, fontsize=8)
            ax.set_ylabel("Time (ms)")
            ax.legend(fontsize=8)

            # Add total time labels
            for i, (c, io_v) in enumerate(zip(compute, io)):
                ax.text(i, c + io_v + 1, f"{c + io_v:.0f}ms", ha="center", va="bottom", fontsize=7)

        plt.suptitle("I/O Elimination: File-based vs Chained Pipeline", fontweight="bold")
        plt.tight_layout()
        fig_path = os.path.join(results_dir, "fig_io_elimination.pdf")
        plt.savefig(fig_path, dpi=150, bbox_inches="tight")
        plt.close()
        print(f"Figure saved: {fig_path}")
    except ImportError:
        print("matplotlib not available for figure generation")

    # Check success criteria
    for size in SIZES:
        fb = next((r for r in all_results if r["method"] == "file_based" and r["size"] == size), None)
        cn = next((r for r in all_results if r["method"] == "chained_numpy" and r["size"] == size), None)
        if fb and cn:
            io_frac = fb["io_pct"]
            io_elim = cn.get("io_elimination_pct", 100)
            pass_io = io_frac > 50
            pass_elim = io_elim > 90
            status = "PASS" if (pass_io and pass_elim) else "FAIL"
            print(f"  {size}x{size}: I/O={io_frac:.0f}% of file-based ({'>50%' if pass_io else '<50%'}) "
                  f"| Chained eliminates {io_elim:.0f}% I/O ({'>90%' if pass_elim else '<90%'}) -> {status}")

    # Write summary
    summary = {"benchmark": "3_io_elimination", "results": all_results}
    with open(os.path.join(results_dir, "bench3_summary.json"), "w") as f:
        json.dump(summary, f, indent=2)

    return 0


if __name__ == "__main__":
    sys.exit(main())
