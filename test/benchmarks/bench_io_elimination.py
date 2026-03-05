#!/usr/bin/env python3
"""Benchmark 3: I/O Elimination (Pipeline Chaining)"""
import csv, json, os, sys, tempfile, time
import numpy as np

venv = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
nvrtc_path = os.path.join(venv, ".venv", "lib", "python3.12", "site-packages", "nvidia", "cuda_nvrtc")
if os.path.isdir(nvrtc_path): os.environ.setdefault("CUDA_PATH", nvrtc_path)

try:
    import rasterio; from rasterio.transform import from_bounds; HAS_RIO = True
except ImportError: HAS_RIO = False

try:
    import cupy as cp; HAS_CUPY = True
except ImportError: HAS_CUPY = False

VIR_R = [0.2777, 0.1050, -0.3308, -4.6342, 6.2282, 4.7763, -5.4354]
VIR_G = [0.0054, 0.6389, 0.2149, -5.7991, 14.1799, -13.7451, 4.6456]
VIR_B = [0.3340, 0.7916, 0.0948, -19.3324, 56.6905, -65.3530, 26.3124]
SIZES = [2048, 8192]
TRIALS = 3; WARMUP = 1

def horner(t, c, xp):
    r = xp.full_like(t, c[6])
    for i in range(5, -1, -1): r = r * t + c[i]
    return r

def gen(N): return np.exp(np.random.default_rng(42).standard_normal((N,N), dtype=np.float32)*2-1)*0.01

def write_arr(path, data):
    if HAS_RIO:
        H, W = data.shape[:2]; bands = data.shape[2] if data.ndim == 3 else 1
        with rasterio.open(path, "w", driver="GTiff", height=H, width=W, count=bands, dtype="float32", transform=from_bounds(0,0,W,H,W,H)) as dst:
            if bands == 1: dst.write(data, 1)
            else:
                for b in range(bands): dst.write(data[:,:,b], b+1)
    else: np.save(path, data)

def read_arr(path):
    if HAS_RIO:
        with rasterio.open(path) as src:
            return src.read(1) if src.count == 1 else np.stack([src.read(b+1) for b in range(src.count)], axis=-1)
    else: return np.load(path)

def file_based(data, tmpdir):
    ext = ".tif" if HAS_RIO else ".npy"; io_t = 0; compute_t = 0
    for i, (name, fn) in enumerate([
        ("calibrate", lambda x: x * 1.0),
        ("multilook", lambda x: x[:x.shape[0]//4*4, :x.shape[1]//4*4].reshape(x.shape[0]//4,4,x.shape[1]//4,4).mean(axis=(1,3))),
        ("speckle", lambda x: sum(x[dy:dy+x.shape[0]-2, dx:dx+x.shape[1]-2] for dy in range(3) for dx in range(3))/9),
        ("dB", lambda x: 10*np.log10(np.maximum(x, 1e-10))),
    ]):
        t0 = time.perf_counter(); data = fn(data); compute_t += (time.perf_counter()-t0)*1000
        t0 = time.perf_counter()
        p = os.path.join(tmpdir, f"s{i}{ext}"); write_arr(p, data); data = read_arr(p)
        io_t += (time.perf_counter()-t0)*1000
    # normalize + colormap
    mn, mx = np.nanmin(data), np.nanmax(data)
    data = np.clip((data-mn)/(mx-mn+1e-10), 0, 1).astype(np.float32)
    t0 = time.perf_counter()
    rgb = np.stack([horner(data, VIR_R, np), horner(data, VIR_G, np), horner(data, VIR_B, np)], axis=-1)
    compute_t += (time.perf_counter()-t0)*1000
    t0 = time.perf_counter(); write_arr(os.path.join(tmpdir, f"final{ext}"), rgb); io_t += (time.perf_counter()-t0)*1000
    return {"method": "file_based", "compute_ms": round(compute_t,3), "io_ms": round(io_t,3),
            "total_ms": round(compute_t+io_t,3), "io_pct": round(100*io_t/(compute_t+io_t),1)}

def chained_numpy(data):
    t0 = time.perf_counter()
    x = data * 1.0
    H,W = x.shape; x = x[:H//4*4,:W//4*4].reshape(H//4,4,W//4,4).mean(axis=(1,3))
    H2,W2 = x.shape; x = sum(x[dy:dy+H2-2, dx:dx+W2-2] for dy in range(3) for dx in range(3))/9
    x = 10*np.log10(np.maximum(x, 1e-10))
    mn,mx = np.nanmin(x),np.nanmax(x); x = np.clip((x-mn)/(mx-mn+1e-10),0,1).astype(np.float32)
    np.stack([horner(x, VIR_R, np), horner(x, VIR_G, np), horner(x, VIR_B, np)], axis=-1)
    return {"method": "chained_numpy", "compute_ms": round((time.perf_counter()-t0)*1000,3), "io_ms": 0, "total_ms": round((time.perf_counter()-t0)*1000,3), "io_pct": 0}

def chained_cupy(data_np):
    if not HAS_CUPY: return None
    data = cp.asarray(data_np); cp.cuda.Device().synchronize()
    t0 = time.perf_counter()
    x = data * cp.float32(1.0)
    H,W = x.shape; x = x[:H//4*4,:W//4*4].reshape(H//4,4,W//4,4).mean(axis=(1,3))
    H2,W2 = x.shape; out = cp.zeros((H2-2,W2-2), dtype=cp.float32)
    for dy in range(3):
        for dx in range(3): out += x[dy:dy+H2-2, dx:dx+W2-2]
    x = out / 9.0
    x = 10.0 * cp.log10(cp.maximum(x, cp.float32(1e-10)))
    mn,mx = float(cp.min(x)),float(cp.max(x)); x = cp.clip((x-mn)/(mx-mn+1e-10),0,1).astype(cp.float32)
    cp.stack([horner(x, VIR_R, cp), horner(x, VIR_G, cp), horner(x, VIR_B, cp)], axis=-1)
    cp.cuda.Device().synchronize(); elapsed = (time.perf_counter()-t0)*1000
    del data, x, out; cp.get_default_memory_pool().free_all_blocks()
    return {"method": "chained_cupy", "compute_ms": round(elapsed,3), "io_ms": 0, "total_ms": round(elapsed,3), "io_pct": 0}

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    results_dir = os.path.join(script_dir, "results"); os.makedirs(results_dir, exist_ok=True)
    print("=" * 60); print("Benchmark 3: I/O Elimination"); print("=" * 60)
    all_results = []
    for size in SIZES:
        print(f"\n--- {size}x{size} ---")
        data = gen(size)
        for method_name, runner in [("file_based", None), ("chained_numpy", chained_numpy), ("chained_cupy", chained_cupy)]:
            if method_name == "chained_cupy" and not HAS_CUPY: continue
            trials = []
            for t in range(WARMUP + TRIALS):
                if method_name == "file_based":
                    with tempfile.TemporaryDirectory() as td: r = file_based(data.copy(), td)
                else: r = runner(data)
                if r and t >= WARMUP: trials.append(r)
            if not trials: continue
            avg = {k: round(np.mean([t[k] for t in trials]),3) if isinstance(trials[0][k], (int,float)) else trials[0][k] for k in trials[0]}
            avg["size"] = size; avg["pixels"] = size*size; all_results.append(avg)
            fb = next((r for r in all_results if r["method"]=="file_based" and r["size"]==size), None)
            if fb and method_name != "file_based":
                sp = fb["total_ms"]/avg["total_ms"] if avg["total_ms"]>0 else 0
                avg["speedup_vs_file"] = round(sp, 1)
                avg["io_elimination_pct"] = 100.0
                print(f"  {method_name}: {avg['total_ms']:.1f}ms ({sp:.1f}x faster)")
            else:
                print(f"  {method_name}: compute={avg['compute_ms']:.1f}ms I/O={avg['io_ms']:.1f}ms total={avg['total_ms']:.1f}ms I/O={avg['io_pct']:.0f}%")

    csv_path = os.path.join(results_dir, "bench3_io_elimination.csv")
    fields = ["method","size","pixels","compute_ms","io_ms","total_ms","io_pct","speedup_vs_file","io_elimination_pct"]
    with open(csv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore"); w.writeheader()
        for r in all_results: w.writerow({k: r.get(k, "") for k in fields})
    print(f"\nCSV: {csv_path}")

    try:
        import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
        fig, axes = plt.subplots(1, len(SIZES), figsize=(6*len(SIZES), 5))
        if len(SIZES) == 1: axes = [axes]
        for ax, size in zip(axes, SIZES):
            md = [r for r in all_results if r["size"]==size]
            names = [r["method"].replace("_","\n") for r in md]
            comp = [r["compute_ms"] for r in md]; io = [r["io_ms"] for r in md]
            x = np.arange(len(names))
            ax.bar(x, comp, 0.6, label="Compute", color="#4ec9d4")
            ax.bar(x, io, 0.6, bottom=comp, label="I/O", color="#e05858")
            ax.set_title(f"{size}x{size}"); ax.set_xticks(x); ax.set_xticklabels(names, fontsize=8)
            ax.set_ylabel("Time (ms)"); ax.legend(fontsize=8)
            for i, (c, v) in enumerate(zip(comp, io)): ax.text(i, c+v+1, f"{c+v:.0f}ms", ha="center", fontsize=7)
        plt.suptitle("I/O Elimination: File-based vs Chained Pipeline", fontweight="bold")
        plt.tight_layout(); plt.savefig(os.path.join(results_dir, "fig_io_elimination.pdf"), dpi=150, bbox_inches="tight"); plt.close()
        print(f"  Figure saved")
    except ImportError: pass

    summary = {"benchmark": "3_io_elimination", "results": all_results}
    with open(os.path.join(results_dir, "bench3_summary.json"), "w") as f: json.dump(summary, f, indent=2)

if __name__ == "__main__":
    main()
