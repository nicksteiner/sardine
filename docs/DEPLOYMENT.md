# Deploying SARdine on JupyterLab On-Demand

Quick-start guide for running SARdine on the NISAR On-Demand system.

## Important: Node.js Version

The On-Demand JupyterLab system has an old Node.js (~v10) that **cannot run
Vite or `npm install`**. The workflow is:

1. **Build locally** (on your laptop / workstation with Node ≥ 16)
2. **Push/copy** the repo (with `dist/`) to the On-Demand system
3. **Run only the server** on On-Demand — it's pure CommonJS, zero dependencies,
   and works on Node ≥ 10

## Setup (on your local machine — one time)

```bash
cd sardine
npm install
npm run build        # produces dist/
git add -f dist/     # force-add the build output
git commit -m "Add built dist for On-Demand deployment"
git push
```

## Deploy on JupyterLab On-Demand

Open a JupyterLab terminal (**File → New → Terminal**):

```bash
cd ~
git clone <repo-url> sardine
cd sardine
```

No `npm install` needed — the server has zero dependencies.

## Launch

```bash
# Default: data at /data/nisar, port 8050
node server/launch.cjs

# Custom data directory
node server/launch.cjs --data-dir /path/to/your/data --port 8050
```

## Access

1. Open your browser to the JupyterLab proxy URL:
   ```
   https://<ondemand-host>/node/<compute-node>/<job-id>/proxy/8050/
   ```
   Or if ports are directly accessible: `http://localhost:8050`

2. In SARdine, select **"Remote Bucket / S3"** as the file type

3. Click the **"SARdine Server (local)"** preset to connect

4. Browse directories, filter by filename, click to stream

## How It Works

The sardine-launch server does three things:

| Route | Purpose |
|-------|---------|
| `/` | Serves the SARdine UI (static `dist/` build) |
| `/api/files?prefix=L2_GCOV/` | Directory listing API — JSON response |
| `/data/<path>` | File serving with HTTP Range support for streaming |

The DataDiscovery browser calls `/api/files` to list directories. When you
click a NISAR `.h5` file, h5chunk streams it via `/data/` using Range requests —
only the metadata + requested chunks are downloaded, not the entire file.

## CLI Options

```
node server/launch.cjs [options]

  --data-dir, -d <path>   Data root directory  (default: /data/nisar)
  --port, -p <number>     Port number          (default: 8050)
  --host <address>        Bind address          (default: 0.0.0.0)
  --help                  Show help
```

## Background Execution

To keep the server running after closing the terminal tab:

```bash
nohup node server/launch.cjs --data-dir /data/nisar > sardine.log 2>&1 &

# Check logs
tail -f sardine.log

# Find and stop later
kill $(lsof -ti:8050)
```

## Updating

When you make code changes locally:

```bash
# On your local machine
npm run build
git add -f dist/
git commit -m "Rebuild dist"
git push

# On On-Demand
cd ~/sardine
git pull
# Restart the server (kill old one first if running)
kill $(lsof -ti:8050) 2>/dev/null
node server/launch.cjs --data-dir /data/nisar
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Port already in use | `kill $(lsof -ti:8050)` then retry, or use `--port 9000` |
| "Built frontend not found" | Run `npm run build` locally, commit `dist/`, push, pull |
| Data directory warnings | Check `--data-dir` path exists and is readable |
| CORS errors | The server adds CORS headers automatically |
| `require is not defined` | You're running `.js` instead of `.cjs` — use `node server/launch.cjs` |
