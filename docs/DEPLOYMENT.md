# Deploying SARdine on JupyterLab On-Demand

Quick-start guide for running SARdine on the NISAR On-Demand system.

## Prerequisites

- Node.js ≥ 18 (already available on On-Demand)
- NISAR data accessible at `/data/nisar/` (or your custom path)
- Terminal access (JupyterLab terminal or SSH)

## Setup (one-time)

```bash
# Clone or copy SARdine to your workspace
cd /home/$USER
git clone <repo-url> sardine
cd sardine

# Install dependencies
npm install

# Build the frontend
npm run build
```

## Launch

### Default (NISAR data at /data/nisar, port 8050)

```bash
npm run launch
```

### Custom data directory

```bash
node server/launch.js --data-dir /path/to/your/data --port 8050
```

### Build + launch (after code changes)

```bash
npm run launch:dev
```

## Access

1. Open your browser to `http://localhost:8050`  
   (Or use the JupyterLab proxy: your JupyterLab URL + `/proxy/8050/`)

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
node server/launch.js [options]

  --data-dir, -d <path>   Data root directory  (default: /data/nisar)
  --port, -p <number>     Port number          (default: 8050)
  --host <address>        Bind address          (default: 0.0.0.0)
  --help                  Show help
```

## JupyterLab Proxy Access

If running inside JupyterLab On-Demand, the URL pattern is typically:

```
https://<ondemand-host>/node/<compute-node>/<job-id>/proxy/8050/
```

JupyterLab's `jupyter-server-proxy` should forward requests automatically.

## Background Execution

To keep the server running after closing the terminal:

```bash
# Using nohup
nohup node server/launch.js --data-dir /data/nisar > sardine.log 2>&1 &

# Check logs
tail -f sardine.log

# Find and stop later
kill $(lsof -ti:8050)
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Port already in use | `kill $(lsof -ti:8050)` then retry, or use `--port 9000` |
| "Built frontend not found" | Run `npm run build` first |
| Data directory warnings | Check `--data-dir` path exists and is readable |
| CORS errors | The server adds CORS headers automatically |
| Large directories slow | The browser pages results — scroll down for "Load More" |
