#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
RESULTS_DIR="$SCRIPT_DIR/results"
mkdir -p "$RESULTS_DIR"

echo "============================================================"
echo "  SARdine Scientific Benchmark Suite"
echo "============================================================"
echo "  Date:    $(date -Iseconds)"
echo "  Project: $PROJECT_DIR"
echo ""

# Record environment
echo "--- Recording Environment ---"
ENV_FILE="$RESULTS_DIR/environment.json"
GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo "N/A")
GPU_MEM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader 2>/dev/null || echo "N/A")
GPU_DRIVER=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null || echo "N/A")
CUDA_VER=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null || echo "N/A")
NODE_VER=$(node --version 2>/dev/null || echo "N/A")
PY_VER=$(python3 --version 2>&1 | cut -d' ' -f2 || echo "N/A")
CHROME_VER=$(google-chrome --version 2>/dev/null || chromium-browser --version 2>/dev/null || echo "N/A")
NUMPY_VER=$(python3 -c "import numpy; print(numpy.__version__)" 2>/dev/null || echo "N/A")
CUPY_VER=$(python3 -c "import cupy; print(cupy.__version__)" 2>/dev/null || echo "N/A")

cat > "$ENV_FILE" <<EOF
{
  "date": "$(date -Iseconds)",
  "gpu": "$GPU_NAME",
  "gpu_memory": "$GPU_MEM",
  "gpu_driver": "$GPU_DRIVER",
  "cuda_compute_cap": "$CUDA_VER",
  "node_version": "$NODE_VER",
  "python_version": "$PY_VER",
  "chrome_version": "$CHROME_VER",
  "numpy_version": "$NUMPY_VER",
  "cupy_version": "$CUPY_VER"
}
EOF
echo "  Environment: $ENV_FILE"
echo "  GPU: $GPU_NAME ($GPU_MEM)"
echo "  Node: $NODE_VER  Python: $PY_VER"
echo "  NumPy: $NUMPY_VER  CuPy: $CUPY_VER"
echo ""

# Benchmark 1: SNAP Coverage Matrix
echo "============================================================"
echo "  Benchmark 1: SNAP Primitive Coverage Matrix"
echo "============================================================"
python3 "$SCRIPT_DIR/snap_coverage_matrix.py"
echo ""

# Benchmark 2a: CPU + CUDA Timing
echo "============================================================"
echo "  Benchmark 2a: CPU (NumPy) + CUDA (CuPy) Timing"
echo "============================================================"
python3 "$SCRIPT_DIR/bench_timing_cpu_cuda.py"
echo ""

# Benchmark 2b+c: WebGL2 Timing (requires Vite)
echo "============================================================"
echo "  Benchmark 2b: WebGL2 Timing (via Puppeteer)"
echo "============================================================"
cd "$PROJECT_DIR"
npx vite --config vite.test.config.js --port 5175 &
VITE_PID=$!
echo "  Vite dev server started (PID: $VITE_PID)"
sleep 4  # Wait for server startup

if node "$SCRIPT_DIR/bench_timing_harvest.js"; then
  echo "  WebGL2 timing complete"
else
  echo "  WARNING: WebGL2 timing failed (continuing without)"
fi

kill $VITE_PID 2>/dev/null || true
wait $VITE_PID 2>/dev/null || true
echo ""

# Benchmark 2d: Combine Results
echo "============================================================"
echo "  Benchmark 2d: Combine Timing Results"
echo "============================================================"
python3 "$SCRIPT_DIR/bench_timing_combine.py"
echo ""

# Benchmark 3: I/O Elimination
echo "============================================================"
echo "  Benchmark 3: I/O Elimination"
echo "============================================================"
python3 "$SCRIPT_DIR/bench_io_elimination.py"
echo ""

# Benchmark 4: h5chunk Streaming
echo "============================================================"
echo "  Benchmark 4: h5chunk Streaming Performance"
echo "============================================================"
cd "$PROJECT_DIR"
node "$SCRIPT_DIR/bench_h5chunk_streaming.mjs"
echo ""

# Benchmark 5: Interactive Responsiveness (requires Vite)
echo "============================================================"
echo "  Benchmark 5: Interactive Responsiveness"
echo "============================================================"
cd "$PROJECT_DIR"
npx vite --config vite.test.config.js --port 5175 &
VITE_PID=$!
echo "  Vite dev server started (PID: $VITE_PID)"
sleep 4

if node "$SCRIPT_DIR/bench_interactive_harvest.js"; then
  echo "  Interactive benchmark complete"
else
  echo "  WARNING: Interactive benchmark failed (continuing without)"
fi

kill $VITE_PID 2>/dev/null || true
wait $VITE_PID 2>/dev/null || true
echo ""

# Compile summary
echo "============================================================"
echo "  Compiling Summary"
echo "============================================================"
python3 -c "
import json, os, glob

results_dir = '$RESULTS_DIR'
summary = {}

# Load individual summaries
for f in glob.glob(os.path.join(results_dir, 'bench*_summary.json')):
    with open(f) as fh:
        data = json.load(fh)
        key = data.get('benchmark', os.path.basename(f))
        summary[key] = data

# Load environment
env_path = os.path.join(results_dir, 'environment.json')
if os.path.exists(env_path):
    with open(env_path) as fh:
        summary['environment'] = json.load(fh)

with open(os.path.join(results_dir, 'summary.json'), 'w') as fh:
    json.dump(summary, fh, indent=2)
print(f'  Summary written to: {results_dir}/summary.json')
"

echo ""
echo "============================================================"
echo "  ALL BENCHMARKS COMPLETE"
echo "============================================================"
echo "  Results directory: $RESULTS_DIR"
echo ""
echo "  Output files:"
ls -la "$RESULTS_DIR/"
