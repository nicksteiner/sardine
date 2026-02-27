#!/usr/bin/env python3
"""
Benchmark 2a: CPU (NumPy) vs CUDA (CuPy) Per-Operation Timing

Measures execution time for 7 SAR image processing operations
across 4 image sizes on both CPU (NumPy) and GPU (CuPy/CUDA).

Operations match the exact GLSL shader implementations in shaders.js.
"""

import csv
import json
import os
import sys
import time

import numpy as np

# Try importing CuPy
try:
    import cupy as cp
    HAS_CUPY = True
except ImportError:
    HAS_CUPY = False
    print("WARNING: CuPy not available. Running CPU-only benchmarks.")

# --- Configuration ---
SIZES = [512, 2048, 8192, 16384]
TRIALS = 5
WARMUP = 2
GAMMA = 0.5

# Viridis polynomial coefficients (exact match to shaders.js:53-64)
VIRIDIS_COEFFS = {
    "r": [0.2777, 0.1050, -0.3308, -4.6342, 6.2282, 4.7763, -5.4354],
    "g": [0.0054, 0.6389, 0.2149, -5.7991, 14.1799, -13.7451, 4.6456],
    "b": [0.3340, 0.7916, 0.0948, -19.3324, 56.6905, -65.3530, 26.3124],
}


def generate_sar_data(N, xp):
    """Generate log-normal SAR power data (realistic amplitude distribution)."""
    rng = xp.random.default_rng(42)
    return xp.exp(rng.standard_normal((N, N), dtype=xp.float32) * 2.0 - 1.0) * 0.01


def horner_eval(t, coeffs, xp):
    """Evaluate 6th-order polynomial using Horner's method."""
    result = xp.full_like(t, coeffs[6])
    for i in range(5, -1, -1):
        result = result * t + coeffs[i]
    return result


# --- NumPy (CPU) Operations ---

def numpy_db(data):
    return 10.0 * np.log10(np.maximum(data, 1e-10))


def numpy_sqrt_stretch(data):
    return np.sqrt(np.clip(data, 0, 1))


def numpy_gamma_stretch(data):
    return np.power(np.clip(data, 0, 1), GAMMA)


def numpy_sigmoid_stretch(data):
    gain = GAMMA * 8.0
    x = np.clip(data, 0, 1)
    raw = 1.0 / (1.0 + np.exp(-gain * (x - 0.5)))
    lo = 1.0 / (1.0 + np.exp(gain * 0.5))
    hi = 1.0 / (1.0 + np.exp(-gain * 0.5))
    return np.clip((raw - lo) / (hi - lo), 0, 1)


def numpy_viridis(data):
    t = np.clip(data, 0, 1).astype(np.float32)
    r = horner_eval(t, VIRIDIS_COEFFS["r"], np)
    g = horner_eval(t, VIRIDIS_COEFFS["g"], np)
    b = horner_eval(t, VIRIDIS_COEFFS["b"], np)
    return np.stack([r, g, b], axis=-1)


def numpy_multilook(data, ml=4):
    H, W = data.shape
    H_out, W_out = H // ml, W // ml
    return data[: H_out * ml, : W_out * ml].reshape(H_out, ml, W_out, ml).mean(axis=(1, 3))


def numpy_rgb_pauli(hh, hv):
    """Pauli-like RGB: R=HH, G=HV, B=HH/max(HV, eps) — dual-pol-h preset."""
    eps = 1e-10
    r_db = 10.0 * np.log10(np.maximum(hh, eps))
    g_db = 10.0 * np.log10(np.maximum(hv, eps))
    ratio = hh / np.maximum(hv, eps)
    b_db = 10.0 * np.log10(np.maximum(ratio, eps))
    return np.stack([r_db, g_db, b_db], axis=-1)


# --- CuPy (CUDA) Operations ---

if HAS_CUPY:
    # Check if nvrtc is available for custom kernels
    HAS_NVRTC = False
    try:
        from cupy_backends.cuda.libs import nvrtc as _nvrtc
        _nvrtc.getVersion()
        HAS_NVRTC = True
    except Exception:
        print("  NOTE: nvrtc not available — using CuPy built-in ops only (no custom CUDA kernels)")

    def cupy_db(data):
        return 10.0 * cp.log10(cp.maximum(data, cp.float32(1e-10)))

    def cupy_sqrt_stretch(data):
        return cp.sqrt(cp.clip(data, 0, 1))

    def cupy_gamma_stretch(data):
        return cp.power(cp.clip(data, 0, 1), GAMMA)

    def cupy_sigmoid_stretch(data):
        """Sigmoid stretch using CuPy built-in ops (matching GLSL implementation)."""
        gain = cp.float32(GAMMA * 8.0)
        x = cp.clip(data, 0, 1)
        raw = 1.0 / (1.0 + cp.exp(-gain * (x - 0.5)))
        lo = 1.0 / (1.0 + cp.exp(gain * 0.5))
        hi = 1.0 / (1.0 + cp.exp(-gain * 0.5))
        return cp.clip((raw - lo) / (hi - lo), 0, 1)

    def cupy_viridis(data):
        """Viridis colormap using CuPy built-in Horner evaluation (same polynomial as GLSL)."""
        t = cp.clip(data, 0, 1).astype(cp.float32)
        r = horner_eval(t, VIRIDIS_COEFFS["r"], cp)
        g = horner_eval(t, VIRIDIS_COEFFS["g"], cp)
        b = horner_eval(t, VIRIDIS_COEFFS["b"], cp)
        return cp.stack([r, g, b], axis=-1)

    def cupy_multilook(data, ml=4):
        H, W = data.shape
        H_out, W_out = H // ml, W // ml
        return data[: H_out * ml, : W_out * ml].reshape(H_out, ml, W_out, ml).mean(axis=(1, 3))

    def cupy_rgb_pauli(hh, hv):
        eps = cp.float32(1e-10)
        r_db = 10.0 * cp.log10(cp.maximum(hh, eps))
        g_db = 10.0 * cp.log10(cp.maximum(hv, eps))
        ratio = hh / cp.maximum(hv, eps)
        b_db = 10.0 * cp.log10(cp.maximum(ratio, eps))
        return cp.stack([r_db, g_db, b_db], axis=-1)


def benchmark(name, fn, trials=TRIALS, warmup=WARMUP, sync_cuda=False):
    """Run benchmark with warmup, return timing stats in ms."""
    for _ in range(warmup):
        fn()
        if sync_cuda and HAS_CUPY:
            cp.cuda.Device().synchronize()

    times = []
    for _ in range(trials):
        if sync_cuda and HAS_CUPY:
            cp.cuda.Device().synchronize()
        t0 = time.perf_counter()
        fn()
        if sync_cuda and HAS_CUPY:
            cp.cuda.Device().synchronize()
        elapsed = (time.perf_counter() - t0) * 1000
        times.append(elapsed)

    times.sort()
    return {
        "name": name,
        "mean_ms": round(float(np.mean(times)), 4),
        "median_ms": round(float(np.median(times)), 4),
        "p95_ms": round(float(np.percentile(times, 95)), 4),
        "min_ms": round(min(times), 4),
        "max_ms": round(max(times), 4),
        "trials": trials,
    }


def run_benchmarks():
    """Run all benchmarks across all sizes."""
    results = []
    script_dir = os.path.dirname(os.path.abspath(__file__))
    results_dir = os.path.join(script_dir, "results")
    os.makedirs(results_dir, exist_ok=True)

    print("=" * 60)
    print("Benchmark 2a: CPU (NumPy) vs CUDA (CuPy) Timing")
    print("=" * 60)
    print(f"  NumPy version: {np.__version__}")
    if HAS_CUPY:
        print(f"  CuPy version: {cp.__version__}")
        props = cp.cuda.runtime.getDeviceProperties(0)
        gpu_name = props["name"].decode() if isinstance(props["name"], bytes) else props["name"]
        print(f"  GPU: {gpu_name}")
    print(f"  Sizes: {SIZES}")
    print(f"  Trials: {TRIALS} (warmup: {WARMUP})")
    print()

    for size in SIZES:
        pixels = size * size
        print(f"--- Size: {size}x{size} ({pixels:,} pixels) ---")

        # Generate CPU data
        np_data = generate_sar_data(size, np)
        # Normalized version for stretch ops
        np_norm = np.clip(np_data / np_data.max(), 0, 1).astype(np.float32)
        # Second band for RGB composite
        np_data2 = generate_sar_data(size, np) * 0.5

        operations_cpu = [
            ("dB_conversion", lambda: numpy_db(np_data)),
            ("sqrt_stretch", lambda: numpy_sqrt_stretch(np_norm)),
            ("gamma_stretch", lambda: numpy_gamma_stretch(np_norm)),
            ("sigmoid_stretch", lambda: numpy_sigmoid_stretch(np_norm)),
            ("viridis_colormap", lambda: numpy_viridis(np_norm)),
            ("multilook_4x4", lambda: numpy_multilook(np_data)),
            ("rgb_composite_pauli", lambda: numpy_rgb_pauli(np_data, np_data2)),
        ]

        for op_name, fn in operations_cpu:
            r = benchmark(f"numpy_{op_name}_{size}", fn)
            r["operation"] = op_name
            r["size"] = size
            r["pixels"] = pixels
            r["backend"] = "numpy"
            results.append(r)
            print(f"  CPU {op_name}: {r['median_ms']:.3f} ms (median)")

        if HAS_CUPY:
            # Generate GPU data
            cp_data = cp.asarray(np_data)
            cp_norm = cp.asarray(np_norm)
            cp_data2 = cp.asarray(np_data2)

            operations_cuda = [
                ("dB_conversion", lambda: cupy_db(cp_data)),
                ("sqrt_stretch", lambda: cupy_sqrt_stretch(cp_norm)),
                ("gamma_stretch", lambda: cupy_gamma_stretch(cp_norm)),
                ("sigmoid_stretch", lambda: cupy_sigmoid_stretch(cp_norm)),
                ("viridis_colormap", lambda: cupy_viridis(cp_norm)),
                ("multilook_4x4", lambda: cupy_multilook(cp_data)),
                ("rgb_composite_pauli", lambda: cupy_rgb_pauli(cp_data, cp_data2)),
            ]

            for op_name, fn in operations_cuda:
                r = benchmark(f"cupy_{op_name}_{size}", fn, sync_cuda=True)
                r["operation"] = op_name
                r["size"] = size
                r["pixels"] = pixels
                r["backend"] = "cupy"
                results.append(r)

                # Compute speedup vs CPU
                cpu_median = next(
                    x["median_ms"]
                    for x in results
                    if x["operation"] == op_name and x["size"] == size and x["backend"] == "numpy"
                )
                speedup = cpu_median / r["median_ms"] if r["median_ms"] > 0 else float("inf")
                r["speedup_vs_cpu"] = round(speedup, 1)
                print(f"  CUDA {op_name}: {r['median_ms']:.3f} ms (median) — {speedup:.1f}x speedup")

            # Free GPU memory for next size
            del cp_data, cp_norm, cp_data2
            cp.get_default_memory_pool().free_all_blocks()

        print()

    # Write CSV
    csv_path = os.path.join(results_dir, "bench2_cpu_cuda.csv")
    fields = [
        "operation", "size", "pixels", "backend",
        "mean_ms", "median_ms", "p95_ms", "min_ms", "max_ms",
        "speedup_vs_cpu", "trials",
    ]
    with open(csv_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for r in results:
            writer.writerow({k: r.get(k, "") for k in fields})
    print(f"Results written to: {csv_path}")

    # Write JSON for combiner
    json_path = os.path.join(results_dir, "bench2_cpu_cuda.json")
    with open(json_path, "w") as f:
        json.dump(results, f, indent=2)

    return results


def main():
    results = run_benchmarks()

    # Print summary table
    print("\n" + "=" * 80)
    print("SUMMARY: Median Speedup (CUDA over NumPy)")
    print("=" * 80)
    if HAS_CUPY:
        print(f"{'Operation':<25} {'512²':>8} {'2048²':>8} {'8192²':>8} {'16384²':>8}")
        print("-" * 61)
        for op in ["dB_conversion", "sqrt_stretch", "gamma_stretch", "sigmoid_stretch",
                    "viridis_colormap", "multilook_4x4", "rgb_composite_pauli"]:
            line = f"{op:<25}"
            for size in SIZES:
                r = next(
                    (x for x in results if x["operation"] == op and x["size"] == size and x["backend"] == "cupy"),
                    None,
                )
                if r and "speedup_vs_cpu" in r:
                    line += f" {r['speedup_vs_cpu']:>7.1f}x"
                else:
                    line += "     N/A"
            print(line)
    else:
        print("  CuPy not available — CPU-only results recorded")

    return 0


if __name__ == "__main__":
    sys.exit(main())
