#!/usr/bin/env python3
"""
Benchmark: CPU/CUDA Box-Filter Multilook

Measures NxN spatial averaging in linear power space across:
  - Kernel sizes: 3x3, 5x5, 7x7, 9x9
  - Scene sizes: 1024, 4096, 8192
  - Backends: NumPy manual, scipy.ndimage.uniform_filter, CuPy

All averaging is in linear power (never dB).
Mean(10*log10(x)) != 10*log10(Mean(x)).

Reports mean and std across 10 runs after 3 warmup.
Correctness: outputs agree within 1% relative error on mean pixel value.
"""
import csv, json, os, time, sys
import numpy as np

# Set CUDA_PATH for CuPy
venv = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
nvrtc_path = os.path.join(venv, ".venv", "lib", "python3.12", "site-packages", "nvidia", "cuda_nvrtc")
if os.path.isdir(nvrtc_path):
    os.environ.setdefault("CUDA_PATH", nvrtc_path)

try:
    from scipy.ndimage import uniform_filter
    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False
    print("WARNING: scipy not available")

try:
    import cupy as cp
    HAS_CUPY = True
except ImportError:
    HAS_CUPY = False
    print("WARNING: CuPy not available")

SCENE_SIZES = [1024, 4096, 8192]
KERNEL_HALFS = [1, 2, 3, 4]  # 3x3, 5x5, 7x7, 9x9
WARMUP = 3
TRIALS = 10

RESULTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")


def gen_sar_power(size, seed=42):
    """Generate log-normal SAR power data (linear power, always > 0)."""
    rng = np.random.default_rng(seed)
    return np.exp(rng.standard_normal((size, size), dtype=np.float32) * 2.0 - 1.0) * 0.01


def numpy_multilook(data, kernel_size):
    """NumPy box-filter multilook via integral image.
    Operates on linear power. Skips zero-valued pixels."""
    n = kernel_size // 2
    H, W = data.shape
    ks = kernel_size

    # Pad input with zeros for boundary handling
    padded = np.pad(data, n, mode='constant', constant_values=0)
    mask = (padded > 0).astype(np.float32)

    # Build prefix sums with leading zero row/column
    pH, pW = padded.shape
    psum_val = np.zeros((pH + 1, pW + 1), dtype=np.float64)
    psum_cnt = np.zeros((pH + 1, pW + 1), dtype=np.float64)
    psum_val[1:, 1:] = np.cumsum(np.cumsum(padded.astype(np.float64), axis=0), axis=1)
    psum_cnt[1:, 1:] = np.cumsum(np.cumsum(mask.astype(np.float64), axis=0), axis=1)

    # For output pixel (i,j), window covers padded[i:i+ks, j:j+ks]
    # Sum = psum[i+ks, j+ks] - psum[i, j+ks] - psum[i+ks, j] + psum[i, j]
    val_sum = (psum_val[ks:ks+H, ks:ks+W] - psum_val[:H, ks:ks+W]
             - psum_val[ks:ks+H, :W] + psum_val[:H, :W])
    cnt_sum = (psum_cnt[ks:ks+H, ks:ks+W] - psum_cnt[:H, ks:ks+W]
             - psum_cnt[ks:ks+H, :W] + psum_cnt[:H, :W])

    out = np.zeros((H, W), dtype=np.float32)
    valid = cnt_sum > 0
    out[valid] = (val_sum[valid] / cnt_sum[valid]).astype(np.float32)
    return out


def scipy_multilook(data, kernel_size):
    """scipy.ndimage.uniform_filter multilook.
    Does NOT handle zero masking (treats zeros as valid).
    This is the fast path for non-masked data."""
    return uniform_filter(data, size=kernel_size, mode='constant', cval=0).astype(np.float32)


def cupy_multilook(data, kernel_size):
    """CuPy box-filter multilook via integral image (basic array ops only).
    Avoids cupyx.scipy.ndimage which needs CUDA header compilation."""
    n = kernel_size // 2
    H, W = data.shape
    ks = kernel_size

    padded = cp.pad(data, n, mode='constant', constant_values=0)
    pH, pW = padded.shape
    psum = cp.zeros((pH + 1, pW + 1), dtype=cp.float64)
    psum[1:, 1:] = cp.cumsum(cp.cumsum(padded.astype(cp.float64), axis=0), axis=1)

    val_sum = (psum[ks:ks+H, ks:ks+W] - psum[:H, ks:ks+W]
             - psum[ks:ks+H, :W] + psum[:H, :W])

    return (val_sum / (ks * ks)).astype(cp.float32)


def bench(name, fn, cuda=False):
    """Run benchmark: WARMUP + TRIALS, return mean/std/median in ms."""
    for _ in range(WARMUP):
        fn()
        if cuda:
            cp.cuda.Device().synchronize()

    times = []
    for _ in range(TRIALS):
        if cuda:
            cp.cuda.Device().synchronize()
        t0 = time.perf_counter()
        fn()
        if cuda:
            cp.cuda.Device().synchronize()
        times.append((time.perf_counter() - t0) * 1000)

    times.sort()
    mean = float(np.mean(times))
    std = float(np.std(times))
    median = float(np.median(times))
    return {
        "mean_ms": round(mean, 4),
        "std_ms": round(std, 4),
        "median_ms": round(median, 4),
        "min_ms": round(min(times), 4),
        "max_ms": round(max(times), 4),
    }


def main():
    os.makedirs(RESULTS_DIR, exist_ok=True)
    results = []

    print("=" * 60)
    print("Multilook Benchmark: CPU (NumPy/scipy) vs CUDA (CuPy)")
    print("All averaging in LINEAR POWER space (never dB)")
    print("=" * 60)
    print(f"  NumPy: {np.__version__}")
    if HAS_SCIPY:
        import scipy
        print(f"  scipy: {scipy.__version__}")
    if HAS_CUPY:
        print(f"  CuPy: {cp.__version__}")
        print(f"  GPU: {cp.cuda.runtime.getDeviceProperties(0)['name']}")
    print(f"  Warmup: {WARMUP}, Trials: {TRIALS}")
    print()

    # ── Correctness validation ──────────────────────────────────────
    print("── Correctness validation (256x256, 3x3) ──")
    val_data = gen_sar_power(256, seed=42)
    np_result = numpy_multilook(val_data, 3)
    np_mean = np_result[np_result > 0].mean()

    if HAS_SCIPY:
        sp_result = scipy_multilook(val_data, 3)
        sp_mean = sp_result[sp_result > 0].mean()
        rel_err = abs(np_mean - sp_mean) / np_mean * 100
        print(f"  NumPy mean: {np_mean:.6f}  scipy mean: {sp_mean:.6f}  rel_err: {rel_err:.4f}%")
        # Note: scipy uniform_filter doesn't mask zeros, so small difference is expected

    if HAS_CUPY:
        cp_data = cp.asarray(val_data)
        cp_result = cupy_multilook(cp_data, 3)
        cp_mean = float(cp_result[cp_result > 0].mean())
        rel_err = abs(np_mean - cp_mean) / np_mean * 100
        print(f"  NumPy mean: {np_mean:.6f}  CuPy mean: {cp_mean:.6f}  rel_err: {rel_err:.4f}%")
        if rel_err >= 1:
            print("  WARNING: CuPy/NumPy disagreement > 1% — check domain")
    print()

    # ── Performance sweep ───────────────────────────────────────────
    for size in SCENE_SIZES:
        print(f"── Scene: {size}x{size} ({size*size:,} pixels) ──")
        data = gen_sar_power(size, seed=42)

        for half in KERNEL_HALFS:
            ks = 2 * half + 1
            looks = ks * ks
            label = f"{ks}x{ks}"

            # NumPy integral-image multilook
            r = bench(f"numpy_{label}_{size}", lambda: numpy_multilook(data, ks))
            mpps = (size * size / 1e6) / (r["median_ms"] / 1000)
            r.update(scene_size=size, kernel_size=ks, looks=looks, backend="numpy",
                     mpixels_per_sec=round(mpps, 1))
            results.append(r)
            print(f"  NumPy  {label}: {r['median_ms']:>9.3f} ms  std={r['std_ms']:.3f}  ({mpps:.0f} Mpix/s)")

            # scipy uniform_filter
            if HAS_SCIPY:
                r = bench(f"scipy_{label}_{size}", lambda: scipy_multilook(data, ks))
                mpps = (size * size / 1e6) / (r["median_ms"] / 1000)
                r.update(scene_size=size, kernel_size=ks, looks=looks, backend="scipy",
                         mpixels_per_sec=round(mpps, 1))
                results.append(r)
                print(f"  scipy  {label}: {r['median_ms']:>9.3f} ms  std={r['std_ms']:.3f}  ({mpps:.0f} Mpix/s)")

            # CuPy uniform_filter
            if HAS_CUPY:
                cd = cp.asarray(data)
                r = bench(f"cupy_{label}_{size}", lambda: cupy_multilook(cd, ks), cuda=True)
                mpps = (size * size / 1e6) / (r["median_ms"] / 1000)
                # Compute speedups
                np_med = next(x["median_ms"] for x in results
                              if x.get("scene_size") == size and x.get("kernel_size") == ks
                              and x.get("backend") == "numpy")
                sp_med = None
                if HAS_SCIPY:
                    sp_med = next(x["median_ms"] for x in results
                                  if x.get("scene_size") == size and x.get("kernel_size") == ks
                                  and x.get("backend") == "scipy")
                speedup_np = round(np_med / r["median_ms"], 1) if r["median_ms"] > 0 else 0
                speedup_sp = round(sp_med / r["median_ms"], 1) if sp_med and r["median_ms"] > 0 else None
                r.update(scene_size=size, kernel_size=ks, looks=looks, backend="cupy",
                         mpixels_per_sec=round(mpps, 1),
                         speedup_vs_numpy=speedup_np,
                         speedup_vs_scipy=speedup_sp)
                results.append(r)
                sp_str = f"  vs_scipy={speedup_sp}x" if speedup_sp else ""
                print(f"  CuPy   {label}: {r['median_ms']:>9.3f} ms  std={r['std_ms']:.3f}  "
                      f"({mpps:.0f} Mpix/s)  vs_numpy={speedup_np}x{sp_str}")
                del cd
                cp.get_default_memory_pool().free_all_blocks()

        print()

    # ── Write results ───────────────────────────────────────────────
    csv_path = os.path.join(RESULTS_DIR, "bench_multilook_cpu.csv")
    fields = ["scene_size", "kernel_size", "looks", "backend", "mean_ms", "std_ms",
              "median_ms", "min_ms", "max_ms", "mpixels_per_sec",
              "speedup_vs_numpy", "speedup_vs_scipy"]
    with open(csv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for r in results:
            w.writerow({k: r.get(k, "") for k in fields})
    print(f"CSV: {csv_path}")

    json_path = os.path.join(RESULTS_DIR, "bench_multilook_cpu.json")
    with open(json_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"JSON: {json_path}")

    # ── Summary table ───────────────────────────────────────────────
    if HAS_CUPY:
        print("\n── CUDA Speedup vs NumPy ──")
        header = "Kernel".ljust(10) + "".join(f"{s:>10}" for s in SCENE_SIZES)
        print(header)
        for half in KERNEL_HALFS:
            ks = 2 * half + 1
            row = f"{ks}x{ks}".ljust(10)
            for size in SCENE_SIZES:
                r = next((x for x in results if x.get("scene_size") == size
                          and x.get("kernel_size") == ks and x.get("backend") == "cupy"), None)
                if r and "speedup_vs_numpy" in r:
                    row += f"{r['speedup_vs_numpy']:>9.1f}x"
                else:
                    row += "      N/A"
            print(row)

    # ── Interactive threshold check ─────────────────────────────────
    print("\n── Interactive threshold (< 16ms for 60fps) ──")
    for size in SCENE_SIZES:
        for half in KERNEL_HALFS:
            ks = 2 * half + 1
            for backend in ["numpy", "scipy", "cupy"]:
                r = next((x for x in results if x.get("scene_size") == size
                          and x.get("kernel_size") == ks and x.get("backend") == backend), None)
                if r:
                    ok = r["median_ms"] < 16
                    sym = "PASS" if ok else "FAIL"
                    print(f"  {backend:>6} {ks}x{ks} @ {size}: {r['median_ms']:>9.3f} ms  [{sym}]")


if __name__ == "__main__":
    main()
