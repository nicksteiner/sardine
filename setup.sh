#!/usr/bin/env bash
# SARdine setup for NISAR On-Demand JupyterLab
#
# Usage:
#   bash setup.sh              # install + build + launch on port 8050
#   bash setup.sh --port 9000  # custom port
#   bash setup.sh --build-only # install + build, don't start server
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PORT=8050
DATA_DIR="/data/nisar"
BUILD_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --port=*)   PORT="${arg#*=}" ;;
    --port)     shift; PORT="${1:-8050}" ;;
    --data-dir=*) DATA_DIR="${arg#*=}" ;;
    --build-only) BUILD_ONLY=true ;;
  esac
done

echo "=== SARdine Setup ==="
echo "  Directory: $SCRIPT_DIR"

# ── Check Node.js version ──────────────────────────────────────────────────
NODE_VERSION=$(node --version 2>/dev/null || echo "none")
echo "  Node.js:   $NODE_VERSION"

NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 16 ] 2>/dev/null; then
  echo ""
  echo "ERROR: Node.js >= 16 required (found $NODE_VERSION)."
  echo "On JupyterHub On-Demand, try:"
  echo "  conda install -c conda-forge nodejs=18"
  exit 1
fi

# ── Install dependencies ───────────────────────────────────────────────────
echo ""
echo "Installing dependencies..."
npm install --legacy-peer-deps 2>&1 | tail -3

# ── Build ──────────────────────────────────────────────────────────────────
echo ""
echo "Building production bundle..."
npm run build 2>&1 | tail -5

if [ ! -d dist ]; then
  echo "ERROR: Build failed — dist/ not created."
  exit 1
fi

echo ""
echo "Build complete: $(du -sh dist | cut -f1)"

if [ "$BUILD_ONLY" = true ]; then
  echo ""
  echo "Done (--build-only). To start the server:"
  echo "  node server/launch.cjs --port $PORT --data-dir $DATA_DIR"
  exit 0
fi

# ── Launch server ──────────────────────────────────────────────────────────
echo ""
echo "Starting SARdine server on port $PORT..."
echo "  Data dir: $DATA_DIR"
echo "  URL:      http://localhost:$PORT"
echo ""
exec node server/launch.cjs --port "$PORT" --data-dir "$DATA_DIR"
