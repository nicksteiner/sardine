#!/bin/bash
# SARdine Benchmark Suite — Master Runner
# Runs all 5 benchmarks and generates figures + summary
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"

mkdir -p "$RESULTS_DIR"

echo "╔══════════════════════════════════════════╗"
echo "║   SARdine Scientific Benchmark Suite     ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# Record environment
ENV_JSON="$RESULTS_DIR/environment.json"
GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo "unknown")
GPU_DRIVER=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null || echo "unknown")
GPU_VRAM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader 2>/dev/null || echo "unknown")
NODE_VER=$(node --version 2>/dev/null || echo "unknown")
PYTHON_VER=$(python3 --version 2>/dev/null | awk '{print $2}' || echo "unknown")
CHROME_VER=$(google-chrome --version 2>/dev/null || chromium --version 2>/dev/null || echo "unknown")

cat > "$ENV_JSON" << EOF
{
  "gpu": "$GPU_NAME",
  "gpu_driver": "$GPU_DRIVER",
  "gpu_vram": "$GPU_VRAM",
  "node": "$NODE_VER",
  "python": "$PYTHON_VER",
  "chrome": "$CHROME_VER",
  "date": "$(date -Iseconds)",
  "hostname": "$(hostname)"
}
EOF
echo "Environment recorded to $ENV_JSON"
echo ""

# ─── Benchmark 1: SNAP Coverage ────────────────────────────────────
echo "━━━ Benchmark 1: SNAP Primitive Coverage ━━━"
python3 "$SCRIPT_DIR/snap_coverage_matrix.py"
echo ""

# ─── Benchmark 2a: CPU/CUDA Timing ─────────────────────────────────
echo "━━━ Benchmark 2a: CPU/CUDA Timing ━━━"
python3 "$SCRIPT_DIR/bench_timing_cpu_cuda.py"
echo ""

# ─── Benchmark 3: I/O Elimination ──────────────────────────────────
echo "━━━ Benchmark 3: I/O Elimination ━━━"
python3 "$SCRIPT_DIR/bench_io_elimination.py"
echo ""

# ─── Benchmark 4: h5chunk Streaming ────────────────────────────────
echo "━━━ Benchmark 4: h5chunk Streaming ━━━"
node "$SCRIPT_DIR/bench_h5chunk_streaming.mjs"
echo ""

# ─── Benchmarks 2b + 5: WebGL via Puppeteer ────────────────────────
echo "━━━ Starting Vite dev server for browser benchmarks ━━━"
cd "$PROJECT_ROOT"
npx vite --config vite.test.config.js &
VITE_PID=$!
sleep 3  # Wait for Vite to start

# Check Vite is running
if ! kill -0 $VITE_PID 2>/dev/null; then
  echo "ERROR: Vite failed to start"
  exit 1
fi
echo "Vite running (PID $VITE_PID)"
echo ""

echo "━━━ Benchmark 2b: WebGL2 Timing ━━━"
node "$SCRIPT_DIR/bench_timing_harvest.js" || echo "  [WARN] WebGL timing benchmark had errors"
echo ""

echo "━━━ Benchmark 5: Interactive Responsiveness ━━━"
node "$SCRIPT_DIR/bench_interactive_harvest.js" || echo "  [WARN] Interactive benchmark had errors"
echo ""

# Stop Vite
echo "Stopping Vite dev server..."
kill $VITE_PID 2>/dev/null || true
wait $VITE_PID 2>/dev/null || true
echo ""

# ─── Combine Benchmark 2 results ───────────────────────────────────
echo "━━━ Combining Benchmark 2 results ━━━"
python3 "$SCRIPT_DIR/bench_timing_combine.py"
echo ""

# ─── Generate all figures ──────────────────────────────────────────
echo "━━━ Generating figures ━━━"
python3 "$SCRIPT_DIR/generate_figures.py"
echo ""

# ─── Summary ────────────────────────────────────────────────────────
echo "╔══════════════════════════════════════════╗"
echo "║          Benchmark Suite Complete        ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "Results in: $RESULTS_DIR/"
ls -lh "$RESULTS_DIR/"
