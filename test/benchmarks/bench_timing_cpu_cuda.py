#!/usr/bin/env python3
"""Benchmark 2a: CPU (NumPy) vs CUDA (CuPy) Per-Operation Timing"""
import csv, json, os, sys, time
import numpy as np

# Set CUDA_PATH for CuPy nvrtc discovery
venv = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
nvrtc_path = os.path.join(venv, ".venv", "lib", "python3.12", "site-packages", "nvidia", "cuda_nvrtc")
if os.path.isdir(nvrtc_path):
    os.environ.setdefault("CUDA_PATH", nvrtc_path)

try:
    import cupy as cp
    HAS_CUPY = True
except ImportError:
    HAS_CUPY = False
    print("WARNING: CuPy not available")

SIZES = [512, 2048, 8192, 16384]
TRIALS = 5
WARMUP = 2
GAMMA = 0.5

VIR = {
    "r": [0.2777, 0.1050, -0.3308, -4.6342, 6.2282, 4.7763, -5.4354],
    "g": [0.0054, 0.6389, 0.2149, -5.7991, 14.1799, -13.7451, 4.6456],
    "b": [0.3340, 0.7916, 0.0948, -19.3324, 56.6905, -65.3530, 26.3124],
}

def gen(N, xp):
    rng = xp.random.default_rng(42)
    return xp.exp(rng.standard_normal((N, N), dtype=xp.float32) * 2.0 - 1.0) * 0.01

def horner(t, c, xp):
    r = xp.full_like(t, c[6])
    for i in range(5, -1, -1): r = r * t + c[i]
    return r

# NumPy ops
def np_db(d): return 10.0 * np.log10(np.maximum(d, 1e-10))
def np_sqrt(d): return np.sqrt(np.clip(d, 0, 1))
def np_gamma(d): return np.power(np.clip(d, 0, 1), GAMMA)
def np_sigmoid(d):
    g = GAMMA * 8.0; x = np.clip(d, 0, 1)
    raw = 1.0/(1.0+np.exp(-g*(x-0.5))); lo = 1.0/(1.0+np.exp(g*0.5)); hi = 1.0/(1.0+np.exp(-g*0.5))
    return np.clip((raw-lo)/(hi-lo), 0, 1)
def np_viridis(d):
    t = np.clip(d, 0, 1).astype(np.float32)
    return np.stack([horner(t, VIR["r"], np), horner(t, VIR["g"], np), horner(t, VIR["b"], np)], axis=-1)
def np_ml(d, ml=4):
    H, W = d.shape; Ho, Wo = H//ml, W//ml
    return d[:Ho*ml, :Wo*ml].reshape(Ho, ml, Wo, ml).mean(axis=(1, 3))
def np_rgb(hh, hv):
    eps = 1e-10
    return np.stack([10*np.log10(np.maximum(hh, eps)), 10*np.log10(np.maximum(hv, eps)),
                     10*np.log10(np.maximum(hh/np.maximum(hv, eps), eps))], axis=-1)

if HAS_CUPY:
    def cp_db(d): return 10.0 * cp.log10(cp.maximum(d, cp.float32(1e-10)))
    def cp_sqrt(d): return cp.sqrt(cp.clip(d, 0, 1))
    def cp_gamma(d): return cp.power(cp.clip(d, 0, 1), GAMMA)
    def cp_sigmoid(d):
        g = cp.float32(GAMMA * 8.0); x = cp.clip(d, 0, 1)
        raw = 1.0/(1.0+cp.exp(-g*(x-0.5))); lo = 1.0/(1.0+cp.exp(g*0.5)); hi = 1.0/(1.0+cp.exp(-g*0.5))
        return cp.clip((raw-lo)/(hi-lo), 0, 1)
    def cp_viridis(d):
        t = cp.clip(d, 0, 1).astype(cp.float32)
        return cp.stack([horner(t, VIR["r"], cp), horner(t, VIR["g"], cp), horner(t, VIR["b"], cp)], axis=-1)
    def cp_ml(d, ml=4):
        H, W = d.shape; Ho, Wo = H//ml, W//ml
        return d[:Ho*ml, :Wo*ml].reshape(Ho, ml, Wo, ml).mean(axis=(1, 3))
    def cp_rgb(hh, hv):
        eps = cp.float32(1e-10)
        return cp.stack([10*cp.log10(cp.maximum(hh, eps)), 10*cp.log10(cp.maximum(hv, eps)),
                         10*cp.log10(cp.maximum(hh/cp.maximum(hv, eps), eps))], axis=-1)

def bench(name, fn, trials=TRIALS, warmup=WARMUP, cuda=False):
    for _ in range(warmup):
        fn()
        if cuda: cp.cuda.Device().synchronize()
    times = []
    for _ in range(trials):
        if cuda: cp.cuda.Device().synchronize()
        t0 = time.perf_counter(); fn()
        if cuda: cp.cuda.Device().synchronize()
        times.append((time.perf_counter() - t0) * 1000)
    times.sort()
    return {"name": name, "mean_ms": round(float(np.mean(times)), 4),
            "median_ms": round(float(np.median(times)), 4),
            "p95_ms": round(float(np.percentile(times, 95)), 4),
            "min_ms": round(min(times), 4), "max_ms": round(max(times), 4)}

def main():
    results = []
    script_dir = os.path.dirname(os.path.abspath(__file__))
    results_dir = os.path.join(script_dir, "results")
    os.makedirs(results_dir, exist_ok=True)

    print("=" * 60)
    print("Benchmark 2a: CPU (NumPy) vs CUDA (CuPy) Timing")
    print("=" * 60)
    print(f"  NumPy: {np.__version__}")
    if HAS_CUPY:
        print(f"  CuPy: {cp.__version__}")
        print(f"  GPU: {cp.cuda.runtime.getDeviceProperties(0)['name']}")

    for size in SIZES:
        px = size * size
        print(f"\n--- {size}x{size} ({px:,} px) ---")
        d = gen(size, np); n = np.clip(d / d.max(), 0, 1).astype(np.float32); d2 = gen(size, np) * 0.5

        ops = [("dB_conversion", lambda: np_db(d)), ("sqrt_stretch", lambda: np_sqrt(n)),
               ("gamma_stretch", lambda: np_gamma(n)), ("sigmoid_stretch", lambda: np_sigmoid(n)),
               ("viridis_colormap", lambda: np_viridis(n)), ("multilook_4x4", lambda: np_ml(d)),
               ("rgb_composite_pauli", lambda: np_rgb(d, d2))]
        for op, fn in ops:
            r = bench(f"numpy_{op}_{size}", fn)
            r.update(operation=op, size=size, pixels=px, backend="numpy")
            results.append(r)
            print(f"  CPU {op}: {r['median_ms']:.3f} ms")

        if HAS_CUPY:
            cd = cp.asarray(d); cn = cp.asarray(n); cd2 = cp.asarray(d2)
            cops = [("dB_conversion", lambda: cp_db(cd)), ("sqrt_stretch", lambda: cp_sqrt(cn)),
                    ("gamma_stretch", lambda: cp_gamma(cn)), ("sigmoid_stretch", lambda: cp_sigmoid(cn)),
                    ("viridis_colormap", lambda: cp_viridis(cn)), ("multilook_4x4", lambda: cp_ml(cd)),
                    ("rgb_composite_pauli", lambda: cp_rgb(cd, cd2))]
            for op, fn in cops:
                r = bench(f"cupy_{op}_{size}", fn, cuda=True)
                cpu_med = next(x["median_ms"] for x in results if x["operation"]==op and x["size"]==size and x["backend"]=="numpy")
                sp = cpu_med / r["median_ms"] if r["median_ms"] > 0 else 0
                r.update(operation=op, size=size, pixels=px, backend="cupy", speedup_vs_cpu=round(sp, 1))
                results.append(r)
                print(f"  CUDA {op}: {r['median_ms']:.3f} ms — {sp:.1f}x")
            del cd, cn, cd2; cp.get_default_memory_pool().free_all_blocks()

    csv_path = os.path.join(results_dir, "bench2_cpu_cuda.csv")
    fields = ["operation","size","pixels","backend","mean_ms","median_ms","p95_ms","min_ms","max_ms","speedup_vs_cpu"]
    with open(csv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore"); w.writeheader()
        for r in results: w.writerow({k: r.get(k, "") for k in fields})
    print(f"\nCSV: {csv_path}")
    with open(os.path.join(results_dir, "bench2_cpu_cuda.json"), "w") as f:
        json.dump(results, f, indent=2)

    if HAS_CUPY:
        print("\nSUMMARY: CUDA Speedup")
        print(f"{'Operation':<25} " + " ".join(f"{s:>8}" for s in SIZES))
        for op in ["dB_conversion","sqrt_stretch","gamma_stretch","sigmoid_stretch","viridis_colormap","multilook_4x4","rgb_composite_pauli"]:
            line = f"{op:<25}"
            for s in SIZES:
                r = next((x for x in results if x["operation"]==op and x["size"]==s and x["backend"]=="cupy"), None)
                line += f" {r['speedup_vs_cpu']:>7.1f}x" if r and "speedup_vs_cpu" in r else "     N/A"
            print(line)

if __name__ == "__main__":
    main()
